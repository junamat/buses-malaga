/**
 * Tests del ciclo de calibración por scraping (tarea 8.2, `lib/calibrationCycle.ts`).
 *
 * Verifica el flujo del ciclo: muestreo de paradas, filtrado de minutos válidos,
 * persistencia en `official_minutes`, y el contrato de errores (web no
 * disponible omite el ciclo sin alterar producción, Requisito 5.5). No toca
 * base de datos: usa dobles del `Repository` y del `HttpTransport`.
 */

import { describe, it, expect, vi } from "vitest";

import { ejecutarCalibracion, urlInformacionParada } from "@/lib/calibrationCycle";
import type { IngestDeps } from "@/lib/ingest";
import type { HttpTransport, Repository } from "@/lib/ports";

function htmlConMinutos(...valores: number[]): string {
  return valores
    .map((v, i) => `<span class="minutos${i + 1}">${v} min.</span>`)
    .join("");
}

function deps(
  transportGet: HttpTransport["get"],
  insertMinutosOficiales = vi.fn().mockResolvedValue(undefined),
): {
  deps: IngestDeps;
  insertMinutosOficiales: ReturnType<typeof vi.fn>;
} {
  const repository = {
    insertMinutosOficiales,
  } as unknown as Repository;
  const transport: HttpTransport = { get: transportGet };
  return {
    deps: { transport, repository, now: () => new Date("2026-10-26T10:00:00Z") },
    insertMinutosOficiales,
  };
}

describe("urlInformacionParada", () => {
  it("añade el codParada como query param", () => {
    expect(urlInformacionParada("https://x/info.html", "590")).toBe(
      "https://x/info.html?codParada=590",
    );
    expect(urlInformacionParada("https://x/info.html?a=1", "590")).toBe(
      "https://x/info.html?a=1&codParada=590",
    );
  });
});

describe("ejecutarCalibracion", () => {
  it("persiste los minutos válidos muestreados (descartando fuera de rango)", async () => {
    const get = vi.fn().mockResolvedValue(htmlConMinutos(5, 785, 12));
    const { deps: d, insertMinutosOficiales } = deps(get);

    const resultado = await ejecutarCalibracion(d, {
      obtenerCodParadas: async () => ["590"],
    });

    expect(resultado.estado).toBe("ok");
    expect(insertMinutosOficiales).toHaveBeenCalledTimes(1);
    const persistidos = insertMinutosOficiales.mock.calls[0][0];
    // El 785 se descarta; quedan 5 y 12.
    expect(persistidos.map((m: { minutos: number }) => m.minutos)).toEqual([5, 12]);
    expect(persistidos.every((m: { codParada: string }) => m.codParada === "590")).toBe(
      true,
    );
  });

  it("reporta fallo si la web no está disponible para todas las paradas (5.5)", async () => {
    const get = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const { deps: d, insertMinutosOficiales } = deps(get);

    const resultado = await ejecutarCalibracion(d, {
      obtenerCodParadas: async () => ["590", "591"],
    });

    expect(resultado.estado).toBe("fallo");
    // No se altera producción: no se intenta persistir nada.
    expect(insertMinutosOficiales).not.toHaveBeenCalled();
  });

  it("omite las paradas que fallan sin abortar el ciclo", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(htmlConMinutos(3))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(htmlConMinutos(9));
    const { deps: d, insertMinutosOficiales } = deps(get);

    const resultado = await ejecutarCalibracion(d, {
      obtenerCodParadas: async () => ["A", "B", "C"],
    });

    expect(resultado.estado).toBe("ok");
    const persistidos = insertMinutosOficiales.mock.calls[0][0];
    expect(persistidos.map((m: { minutos: number }) => m.minutos)).toEqual([3, 9]);
  });

  it("no lanza y reporta fallo si no se puede obtener la lista de paradas", async () => {
    const get = vi.fn();
    const { deps: d } = deps(get);

    const resultado = await ejecutarCalibracion(d, {
      obtenerCodParadas: async () => {
        throw new Error("sin conexión a BD");
      },
    });

    expect(resultado.estado).toBe("fallo");
    expect(get).not.toHaveBeenCalled();
  });

  it("es ok sin persistir cuando no hay paradas que muestrear", async () => {
    const get = vi.fn();
    const { deps: d, insertMinutosOficiales } = deps(get);

    const resultado = await ejecutarCalibracion(d, {
      obtenerCodParadas: async () => [],
    });

    expect(resultado.estado).toBe("ok");
    expect(insertMinutosOficiales).not.toHaveBeenCalled();
  });
});
