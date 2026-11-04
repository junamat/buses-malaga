/**
 * Adaptador `local-auth` del puerto `AuthProvider` (tarea 14.3).
 *
 * Implementación local simple para el modo `local-postgres`, donde no hay
 * Supabase Auth. Cubre el mismo contrato con credenciales en el Postgres local
 * (`db/migrations/0005_local_auth.sql`):
 *
 * - Contraseñas con `scrypt` y sal aleatoria (`scrypt$<saltB64>$<hashB64>`),
 *   comparadas en tiempo constante. Si el correo no existe se calcula igualmente
 *   un hash para no revelar qué cuentas existen por el tiempo de respuesta.
 * - Token de sesión aleatorio de 32 bytes; en la base de datos solo se guarda su
 *   SHA-256. La sesión caduca a los 30 días desde el último acceso, que se
 *   renueva en cada verificación (7.2). `logout` la borra (7.5).
 * - Bloqueo tras 5 fallos consecutivos con {@link intentarLogin} (7.4).
 *
 * **Modo "sin login" / usuario de desarrollo** (`devUser`): una petición sin
 * token se resuelve como el usuario de desarrollo, con `user_id` fijo
 * {@link DEV_USER_ID}, para no tener que iniciar sesión mientras se desarrolla.
 * Una petición que sí trae token se verifica normalmente.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { AuthError } from "@/lib/ports";
import type { AuthProvider, Identidad, Sesion, VerificacionSesion } from "@/lib/ports";
import { intentarLogin, normalizarIdentidad, type LoginAttemptStore } from "@/lib/loginLockout";

/** `user_id` fijo del usuario de desarrollo. */
export const DEV_USER_ID = "00000000-0000-4000-8000-000000000001";
export const DEV_USER: Identidad = { userId: DEV_USER_ID, email: "dev@localhost" };

/** Validez de la sesión desde el último acceso (30 días, Requisito 7.2). */
export const SESION_INACTIVIDAD_MS = 30 * 24 * 60 * 60 * 1000;

export interface UsuarioLocal {
  userId: string;
  email: string;
  passwordHash: string;
}

export interface SesionLocal {
  userId: string;
  email: string;
  lastAccess: Date;
}

/** Persistencia de credenciales y sesiones del adaptador `local-auth`. */
export interface LocalAuthStore {
  buscarUsuario(email: string): Promise<UsuarioLocal | null>;
  crearSesion(tokenHash: string, userId: string, ahora: Date): Promise<void>;
  buscarSesion(tokenHash: string): Promise<SesionLocal | null>;
  tocarSesion(tokenHash: string, ahora: Date): Promise<void>;
  borrarSesion(tokenHash: string): Promise<void>;
}

export interface LocalAuthOptions {
  store: LocalAuthStore;
  intentos: LoginAttemptStore;
  devUser: boolean;
  ahora?: () => Date;
}

// ---------------------------------------------------------------------------
// Contraseñas y tokens
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verificarPassword(password: string, almacenado: string): boolean {
  const [esquema, saltB64, hashB64] = almacenado.split("$");
  if (esquema !== "scrypt" || saltB64 === undefined || hashB64 === undefined) {
    return false;
  }
  const esperado = Buffer.from(hashB64, "base64");
  const calculado = scryptSync(password, Buffer.from(saltB64, "base64"), esperado.length);
  return esperado.length > 0 && timingSafeEqual(esperado, calculado);
}

/** Hash de relleno para igualar el coste cuando el correo no existe. */
let hashRelleno: string | null = null;
function obtenerHashRelleno(): string {
  hashRelleno ??= hashPassword(randomBytes(16).toString("hex"));
  return hashRelleno;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// Adaptador
// ---------------------------------------------------------------------------

export function createLocalAuthProvider(opts: LocalAuthOptions): AuthProvider {
  const ahora = opts.ahora ?? (() => new Date());

  const provider: AuthProvider = {
    async login(email, password): Promise<Sesion> {
      const instante = ahora();
      const resultado = await intentarLogin(opts.intentos, email, instante, async () => {
        const usuario = await opts.store.buscarUsuario(normalizarIdentidad(email));
        const ok = verificarPassword(password, usuario?.passwordHash ?? obtenerHashRelleno());
        return usuario !== null && ok ? usuario : null;
      });
      if (resultado.estado === "bloqueado") {
        throw new AuthError("bloqueado", "Inicio de sesión bloqueado temporalmente.");
      }
      if (resultado.estado === "credenciales_invalidas") {
        throw new AuthError("credenciales_invalidas", "Las credenciales son incorrectas.");
      }
      const usuario = resultado.valor;
      const token = randomBytes(32).toString("base64url");
      await opts.store.crearSesion(hashToken(token), usuario.userId, instante);
      return {
        identidad: { userId: usuario.userId, email: usuario.email },
        token,
        expiraEn: new Date(instante.getTime() + SESION_INACTIVIDAD_MS).toISOString(),
      };
    },

    async logout(token): Promise<void> {
      await opts.store.borrarSesion(hashToken(token));
    },

    async verificarSesion(token): Promise<VerificacionSesion> {
      if (token === null || token === undefined || token === "") {
        return opts.devUser
          ? { autenticado: true, identidad: DEV_USER }
          : { autenticado: false, motivo: "sin_sesion" };
      }
      const tokenHash = hashToken(token);
      const sesion = await opts.store.buscarSesion(tokenHash);
      if (sesion === null) {
        return { autenticado: false, motivo: "sesion_invalida" };
      }
      const instante = ahora();
      if (instante.getTime() - sesion.lastAccess.getTime() > SESION_INACTIVIDAD_MS) {
        await opts.store.borrarSesion(tokenHash);
        return { autenticado: false, motivo: "expirada" };
      }
      await opts.store.tocarSesion(tokenHash, instante);
      return { autenticado: true, identidad: { userId: sesion.userId, email: sesion.email } };
    },

    async resolverUserId(token): Promise<string | null> {
      const v = await provider.verificarSesion(token);
      return v.autenticado ? v.identidad.userId : null;
    },
  };
  return provider;
}
