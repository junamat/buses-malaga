/**
 * Adaptador `supabase-auth` del puerto `AuthProvider` (tarea 14.2).
 *
 * Delega en Supabase Auth (GoTrue) a través de su API REST, sin depender del
 * SDK de Supabase: el servidor solo necesita la URL del proyecto y la clave
 * `anon`. Se usa en los modos `supabase-cloud` y `supabase-local`.
 *
 * - `login`: `POST /auth/v1/token?grant_type=password`. Devuelve el
 *   `access_token` (JWT de Supabase) como token de sesión (7.1). La validez la
 *   fija `jwt_expiry` de GoTrue (30 días en `supabase/config.toml`, 7.2).
 * - Bloqueo tras 5 fallos (7.4): GoTrue solo limita por IP, así que el bloqueo
 *   por identidad lo aplica {@link intentarLogin} sobre `auth_login_attempts`.
 * - `logout`: `POST /auth/v1/logout`, que revoca la sesión en GoTrue (7.5).
 * - `verificarSesion`: `GET /auth/v1/user` con el JWT. GoTrue comprueba la
 *   firma, la expiración y que la sesión no se haya cerrado; así no hace falta
 *   distribuir el secreto JWT al servidor de la app.
 *
 * Todas las llamadas tienen un timeout de 5 s (7.1, 7.5). Un fallo de red o un
 * 5xx de GoTrue es `AuthError("no_disponible")` y no cuenta como intento fallido.
 */

import { AuthError } from "@/lib/ports";
import type { AuthProvider, Identidad, Sesion, VerificacionSesion } from "@/lib/ports";
import { intentarLogin, type LoginAttemptStore } from "@/lib/loginLockout";

export const AUTH_TIMEOUT_MS = 5000;

export interface SupabaseAuthOptions {
  url: string;
  anonKey: string;
  intentos: LoginAttemptStore;
  /** Inyectable en tests. Por defecto, el `fetch` global. */
  fetch?: typeof fetch;
  ahora?: () => Date;
}

interface GoTrueUser {
  id: string;
  email?: string;
}

interface GoTrueTokenResponse {
  access_token: string;
  expires_in?: number;
  expires_at?: number;
  user: GoTrueUser;
}

export function createSupabaseAuthProvider(opts: SupabaseAuthOptions): AuthProvider {
  const base = opts.url.replace(/\/+$/, "");
  const fetchFn = opts.fetch ?? fetch;
  const ahora = opts.ahora ?? (() => new Date());

  async function llamar(
    path: string,
    init: { method: string; token?: string; body?: unknown },
  ): Promise<Response> {
    const headers: Record<string, string> = { apikey: opts.anonKey };
    if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    try {
      return await fetchFn(`${base}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AuthError(
        "no_disponible",
        `Supabase Auth no responde: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function identidadDe(user: GoTrueUser): Identidad {
    return user.email === undefined ? { userId: user.id } : { userId: user.id, email: user.email };
  }

  const provider: AuthProvider = {
    async login(email, password): Promise<Sesion> {
      const resultado = await intentarLogin(opts.intentos, email, ahora(), async () => {
        const res = await llamar("/auth/v1/token?grant_type=password", {
          method: "POST",
          body: { email, password },
        });
        if (res.status === 400 || res.status === 401) {
          return null;
        }
        if (!res.ok) {
          throw new AuthError("no_disponible", `Supabase Auth respondió ${res.status}.`);
        }
        const cuerpo = (await res.json()) as GoTrueTokenResponse;
        const expiraEnMs =
          cuerpo.expires_at !== undefined
            ? cuerpo.expires_at * 1000
            : ahora().getTime() + (cuerpo.expires_in ?? 3600) * 1000;
        return {
          identidad: identidadDe(cuerpo.user),
          token: cuerpo.access_token,
          expiraEn: new Date(expiraEnMs).toISOString(),
        };
      });
      if (resultado.estado === "bloqueado") {
        throw new AuthError("bloqueado", "Inicio de sesión bloqueado temporalmente.");
      }
      if (resultado.estado === "credenciales_invalidas") {
        throw new AuthError("credenciales_invalidas", "Las credenciales son incorrectas.");
      }
      return resultado.valor;
    },

    async logout(token): Promise<void> {
      const res = await llamar("/auth/v1/logout", { method: "POST", token });
      // 401/403: la sesión ya no era válida; el resultado es el mismo.
      if (!res.ok && res.status !== 401 && res.status !== 403) {
        throw new AuthError("no_disponible", `Supabase Auth respondió ${res.status}.`);
      }
    },

    async verificarSesion(token): Promise<VerificacionSesion> {
      if (token === null || token === undefined || token === "") {
        return { autenticado: false, motivo: "sin_sesion" };
      }
      const res = await llamar("/auth/v1/user", { method: "GET", token });
      if (res.ok) {
        return { autenticado: true, identidad: identidadDe((await res.json()) as GoTrueUser) };
      }
      if (res.status === 401 || res.status === 403) {
        const texto = await res.text().catch(() => "");
        return {
          autenticado: false,
          motivo: /expired/i.test(texto) ? "expirada" : "sesion_invalida",
        };
      }
      throw new AuthError("no_disponible", `Supabase Auth respondió ${res.status}.`);
    },

    async resolverUserId(token): Promise<string | null> {
      const v = await provider.verificarSesion(token);
      return v.autenticado ? v.identidad.userId : null;
    },
  };
  return provider;
}
