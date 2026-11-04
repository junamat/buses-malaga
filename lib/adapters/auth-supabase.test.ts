/**
 * Tests del adaptador `supabase-auth` (tareas 14.2 y 14.5) con un `fetch`
 * simulado que imita la API REST de GoTrue.
 */

import { describe, it, expect, vi } from "vitest";

import { createSupabaseAuthProvider } from "@/lib/adapters/auth-supabase";
import { createMemoryLoginAttemptStore, MAX_INTENTOS_FALLIDOS } from "@/lib/loginLockout";

const URL_BASE = "http://supabase.test";
const USER = { id: "22222222-2222-4222-8222-222222222222", email: "ana@example.com" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** GoTrue simulado: una cuenta, tokens revocables. */
function goTrue() {
  const validos = new Set<string>();
  let n = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    expect(headers.get("apikey")).toBe("anon");
    const bearer = headers.get("authorization")?.replace("Bearer ", "");
    if (url === `${URL_BASE}/auth/v1/token?grant_type=password`) {
      const { email, password } = JSON.parse(String(init?.body));
      if (email !== USER.email || password !== "secreta") {
        return json(400, { error: "invalid_grant", error_description: "Invalid login credentials" });
      }
      const token = `jwt-${++n}`;
      validos.add(token);
      return json(200, { access_token: token, expires_in: 2592000, user: USER });
    }
    if (url === `${URL_BASE}/auth/v1/logout`) {
      validos.delete(bearer ?? "");
      return new Response(null, { status: 204 });
    }
    if (url === `${URL_BASE}/auth/v1/user`) {
      if (bearer === "caducado") return json(403, { msg: "invalid JWT: token is expired" });
      return validos.has(bearer ?? "") ? json(200, USER) : json(401, { msg: "invalid" });
    }
    return json(404, {});
  });
  return { fetchMock };
}

function setup() {
  const { fetchMock } = goTrue();
  const auth = createSupabaseAuthProvider({
    url: `${URL_BASE}/`,
    anonKey: "anon",
    intentos: createMemoryLoginAttemptStore(),
    fetch: fetchMock as unknown as typeof fetch,
    ahora: () => new Date("2026-11-04T10:00:00Z"),
  });
  return { auth, fetchMock };
}

describe("supabase-auth", () => {
  it("login devuelve el JWT y la identidad; la expiración sigue a expires_in (7.1, 7.2)", async () => {
    const { auth } = setup();
    const sesion = await auth.login(USER.email, "secreta");
    expect(sesion.identidad).toEqual({ userId: USER.id, email: USER.email });
    expect(sesion.expiraEn).toBe("2026-12-04T10:00:00.000Z");
    expect(await auth.resolverUserId(sesion.token)).toBe(USER.id);
  });

  it("credenciales inválidas → credenciales_invalidas (7.3)", async () => {
    const { auth } = setup();
    await expect(auth.login(USER.email, "mala")).rejects.toMatchObject({ motivo: "credenciales_invalidas" });
  });

  it("tras 5 fallos bloquea sin volver a consultar GoTrue (7.4)", async () => {
    const { auth, fetchMock } = setup();
    for (let i = 0; i < MAX_INTENTOS_FALLIDOS; i++) {
      await auth.login(USER.email, "mala").catch(() => undefined);
    }
    const llamadas = fetchMock.mock.calls.length;
    await expect(auth.login(USER.email, "secreta")).rejects.toMatchObject({ motivo: "bloqueado" });
    expect(fetchMock.mock.calls.length).toBe(llamadas);
  });

  it("logout revoca la sesión (7.5)", async () => {
    const { auth } = setup();
    const { token } = await auth.login(USER.email, "secreta");
    await auth.logout(token);
    expect((await auth.verificarSesion(token)).autenticado).toBe(false);
  });

  it("distingue sin sesión, token expirado y token inválido", async () => {
    const { auth } = setup();
    expect(await auth.verificarSesion(null)).toEqual({ autenticado: false, motivo: "sin_sesion" });
    expect(await auth.verificarSesion("caducado")).toEqual({ autenticado: false, motivo: "expirada" });
    expect(await auth.verificarSesion("otro")).toEqual({ autenticado: false, motivo: "sesion_invalida" });
  });

  it("un fallo de red es no_disponible y no cuenta como intento fallido", async () => {
    const intentos = createMemoryLoginAttemptStore();
    const auth = createSupabaseAuthProvider({
      url: URL_BASE,
      anonKey: "anon",
      intentos,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(auth.login(USER.email, "x")).rejects.toMatchObject({ motivo: "no_disponible" });
    await expect(auth.verificarSesion("t")).rejects.toMatchObject({ motivo: "no_disponible" });
    expect((await intentos.leer(USER.email)).fallos).toBe(0);
  });
});
