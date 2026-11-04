/**
 * Tests del bloqueo tras intentos fallidos (Requisito 7.4, `lib/loginLockout.ts`).
 */

import { describe, it, expect, vi } from "vitest";

import {
  BLOQUEO_SEGUNDOS,
  MAX_INTENTOS_FALLIDOS,
  createMemoryLoginAttemptStore,
  intentarLogin,
} from "@/lib/loginLockout";

const T0 = new Date("2026-11-04T10:00:00Z");
const en = (s: number): Date => new Date(T0.getTime() + s * 1000);

describe("intentarLogin", () => {
  it("bloquea al 5.º fallo consecutivo y durante 300 s no comprueba credenciales", async () => {
    const store = createMemoryLoginAttemptStore();
    const mal = vi.fn().mockResolvedValue(null);

    for (let i = 1; i < MAX_INTENTOS_FALLIDOS; i++) {
      expect(await intentarLogin(store, "a@b.es", T0, mal)).toEqual({ estado: "credenciales_invalidas" });
    }
    expect(await intentarLogin(store, "a@b.es", T0, mal)).toEqual({ estado: "bloqueado" });
    expect(mal).toHaveBeenCalledTimes(MAX_INTENTOS_FALLIDOS);

    // Ni las credenciales correctas pasan durante el bloqueo.
    const bien = vi.fn().mockResolvedValue("ok");
    expect(await intentarLogin(store, "a@b.es", en(BLOQUEO_SEGUNDOS - 1), bien)).toEqual({ estado: "bloqueado" });
    expect(bien).not.toHaveBeenCalled();

    // Tras 300 s se vuelve a admitir.
    expect(await intentarLogin(store, "a@b.es", en(BLOQUEO_SEGUNDOS), bien)).toEqual({ estado: "ok", valor: "ok" });
  });

  it("un acierto reinicia el contador de fallos", async () => {
    const store = createMemoryLoginAttemptStore();
    const mal = async (): Promise<null> => null;
    for (let i = 0; i < MAX_INTENTOS_FALLIDOS - 1; i++) await intentarLogin(store, "a@b.es", T0, mal);
    await intentarLogin(store, "a@b.es", T0, async () => "ok");
    for (let i = 0; i < MAX_INTENTOS_FALLIDOS - 1; i++) {
      expect((await intentarLogin(store, "a@b.es", T0, mal)).estado).toBe("credenciales_invalidas");
    }
  });

  it("la identidad no distingue mayúsculas ni espacios; otras identidades no se ven afectadas", async () => {
    const store = createMemoryLoginAttemptStore();
    const mal = async (): Promise<null> => null;
    for (let i = 0; i < MAX_INTENTOS_FALLIDOS; i++) await intentarLogin(store, i % 2 ? " A@B.es" : "a@b.ES", T0, mal);
    expect((await intentarLogin(store, "a@b.es", T0, mal)).estado).toBe("bloqueado");
    expect((await intentarLogin(store, "otro@b.es", T0, mal)).estado).toBe("credenciales_invalidas");
  });
});
