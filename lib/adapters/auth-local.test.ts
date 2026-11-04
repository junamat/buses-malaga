/**
 * Tests del adaptador `local-auth` (tareas 14.3 y 14.5) con almacenes en
 * memoria: login, credenciales inválidas, bloqueo, expiración de 30 días desde
 * el último acceso, logout y usuario de desarrollo (Requisitos 7.1–7.5).
 */

import { describe, it, expect } from "vitest";

import {
  DEV_USER_ID,
  SESION_INACTIVIDAD_MS,
  createLocalAuthProvider,
  hashPassword,
  verificarPassword,
  type LocalAuthStore,
  type SesionLocal,
  type UsuarioLocal,
} from "@/lib/adapters/auth-local";
import { createMemoryLoginAttemptStore, MAX_INTENTOS_FALLIDOS } from "@/lib/loginLockout";
import { AuthError } from "@/lib/ports";

const USER: UsuarioLocal = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "ana@example.com",
  passwordHash: hashPassword("secreta"),
};

function memoryStore(): LocalAuthStore & { sesiones: Map<string, SesionLocal> } {
  const sesiones = new Map<string, SesionLocal>();
  return {
    sesiones,
    async buscarUsuario(email) {
      return email === USER.email ? USER : null;
    },
    async crearSesion(tokenHash, userId, ahora) {
      sesiones.set(tokenHash, { userId, email: USER.email, lastAccess: ahora });
    },
    async buscarSesion(tokenHash) {
      return sesiones.get(tokenHash) ?? null;
    },
    async tocarSesion(tokenHash, ahora) {
      const s = sesiones.get(tokenHash);
      if (s) s.lastAccess = ahora;
    },
    async borrarSesion(tokenHash) {
      sesiones.delete(tokenHash);
    },
  };
}

function setup(devUser = false) {
  let ahora = new Date("2026-11-04T10:00:00Z");
  const store = memoryStore();
  const auth = createLocalAuthProvider({
    store,
    intentos: createMemoryLoginAttemptStore(),
    devUser,
    ahora: () => ahora,
  });
  return { auth, store, avanzar: (ms: number) => (ahora = new Date(ahora.getTime() + ms)) };
}

describe("hash de contraseñas", () => {
  it("verifica la contraseña correcta y rechaza otras o formatos inválidos", () => {
    const h = hashPassword("x");
    expect(verificarPassword("x", h)).toBe(true);
    expect(verificarPassword("y", h)).toBe(false);
    expect(verificarPassword("x", "plano")).toBe(false);
    expect(hashPassword("x")).not.toBe(h);
  });
});

describe("local-auth", () => {
  it("login con credenciales válidas devuelve sesión e identidad; el token no se guarda en claro", async () => {
    const { auth, store } = setup();
    const sesion = await auth.login(" ANA@example.com ", "secreta");
    expect(sesion.identidad.userId).toBe(USER.userId);
    expect(sesion.token.length).toBeGreaterThan(20);
    expect([...store.sesiones.keys()]).not.toContain(sesion.token);
    expect(await auth.resolverUserId(sesion.token)).toBe(USER.userId);
  });

  it("credenciales inválidas se rechazan sin crear sesión (7.3)", async () => {
    const { auth, store } = setup();
    await expect(auth.login(USER.email, "mala")).rejects.toMatchObject({ motivo: "credenciales_invalidas" });
    await expect(auth.login("nadie@example.com", "secreta")).rejects.toBeInstanceOf(AuthError);
    expect(store.sesiones.size).toBe(0);
  });

  it("tras 5 fallos bloquea incluso con la contraseña correcta (7.4)", async () => {
    const { auth, avanzar } = setup();
    for (let i = 0; i < MAX_INTENTOS_FALLIDOS; i++) {
      await auth.login(USER.email, "mala").catch(() => undefined);
    }
    await expect(auth.login(USER.email, "secreta")).rejects.toMatchObject({ motivo: "bloqueado" });
    avanzar(300_000);
    await expect(auth.login(USER.email, "secreta")).resolves.toBeDefined();
  });

  it("la sesión caduca 30 días después del último acceso, y cada acceso la renueva (7.2)", async () => {
    const { auth, avanzar } = setup();
    const { token } = await auth.login(USER.email, "secreta");
    avanzar(SESION_INACTIVIDAD_MS - 1000);
    expect((await auth.verificarSesion(token)).autenticado).toBe(true);
    avanzar(SESION_INACTIVIDAD_MS - 1000);
    expect((await auth.verificarSesion(token)).autenticado).toBe(true);
    avanzar(SESION_INACTIVIDAD_MS + 1);
    expect(await auth.verificarSesion(token)).toEqual({ autenticado: false, motivo: "expirada" });
  });

  it("logout invalida el token (7.5)", async () => {
    const { auth } = setup();
    const { token } = await auth.login(USER.email, "secreta");
    await auth.logout(token);
    expect(await auth.verificarSesion(token)).toEqual({ autenticado: false, motivo: "sesion_invalida" });
  });

  it("sin token: sin sesión, salvo con el usuario de desarrollo activado", async () => {
    expect(await setup(false).auth.verificarSesion(null)).toEqual({ autenticado: false, motivo: "sin_sesion" });
    expect(await setup(true).auth.resolverUserId(undefined)).toBe(DEV_USER_ID);
  });

  it("con usuario de desarrollo, un token inválido sigue rechazándose", async () => {
    expect((await setup(true).auth.verificarSesion("falso")).autenticado).toBe(false);
  });
});
