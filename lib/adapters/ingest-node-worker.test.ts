/**
 * Tests del adaptador `IngestScheduler` por `node-worker` (modo local-postgres).
 *
 * Verifican la lógica verificable sin red ni base de datos:
 *
 * - `NodeFetchTransport`: respeta el timeout (aborta vía `AbortController` y
 *   lanza), lanza ante respuestas no 2xx y devuelve el cuerpo en el camino feliz,
 *   con un `fetch` global simulado.
 * - `NodeWorkerIngestScheduler.runOnce`: delega en el núcleo compartido
 *   (`ejecutarIngesta`) con el transporte y el repositorio inyectados, registra
 *   el resultado en `ingest_log` (vía `repository.logIngesta`) y no deja que un
 *   fallo del registro enmascare el resultado del ciclo.
 * - `start()`/`stop()`: programan y limpian temporizadores con tiempo simulado,
 *   y no programan calibración si no hay callback conectado.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  NodeFetchTransport,
  NodeWorkerIngestScheduler,
} from "@/lib/adapters/ingest-node-worker";
import type { IngestConfig } from "@/lib/ingest";
import type { IngestResult, Repository } from "@/lib/ports";

// ---------------------------------------------------------------------------
// Dobles mínimos
// ---------------------------------------------------------------------------

/** Repositorio doble: solo necesita capturar `logIngesta` e `insertPosiciones`. */
function fakeRepository(
  overrides: Partial<Repository> = {},
): { repository: Repository; logs: IngestResult[] } {
  const logs: IngestResult[] = [];
  const repository = {
    async insertPosiciones() {},
    async purgePosicionesAntiguas() {
      return 0;
    },
    async logIngesta(result: IngestResult) {
      logs.push(result);
    },
    ...overrides,
  } as unknown as Repository;
  return { repository, logs };
}

const CONFIG_BASE: IngestConfig = {
  posiciones: { fuenteUrl: "https://datos/lineasyubicaciones.csv" },
};

// ---------------------------------------------------------------------------
// NodeFetchTransport
// ---------------------------------------------------------------------------

describe("NodeFetchTransport", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("devuelve el cuerpo como texto en una respuesta 2xx", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("cod_bus,cod_linea\n1,41", { status: 200 });
    }) as unknown as typeof fetch;

    const transporte = new NodeFetchTransport();
    const cuerpo = await transporte.get("https://datos/x.csv");
    expect(cuerpo).toContain("cod_bus");
  });

  it("lanza ante una respuesta no 2xx", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;

    const transporte = new NodeFetchTransport();
    await expect(transporte.get("https://datos/x.csv")).rejects.toThrow(/503/);
  });

  it("aborta y lanza cuando se excede el timeout", async () => {
    // fetch que rechaza con AbortError cuando se dispara la señal del controlador.
    globalThis.fetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("abortado");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    vi.useFakeTimers();
    const transporte = new NodeFetchTransport();
    const promesa = transporte.get("https://datos/lento.csv", 30_000);
    // Capturamos el rechazo cuanto antes para evitar un unhandled rejection al
    // avanzar los temporizadores.
    const expectativa = expect(promesa).rejects.toThrow(/Timeout de 30000 ms/);
    await vi.advanceTimersByTimeAsync(30_000);
    await expectativa;
  });
});

// ---------------------------------------------------------------------------
// NodeWorkerIngestScheduler.runOnce
// ---------------------------------------------------------------------------

describe("NodeWorkerIngestScheduler.runOnce", () => {
  it("delega en el núcleo compartido y registra el resultado en ingest_log", async () => {
    const { repository, logs } = fakeRepository({
      async insertPosiciones() {},
    });
    const transport = {
      async get() {
        // CSV mínimo bien formado: una fila válida (codBus, codLinea, sentido,
        // lon, lat, codParIni, last_update).
        return "900,41,1,-4.42,36.72,100,2024-01-01T00:00:00Z";
      },
    };

    const scheduler = new NodeWorkerIngestScheduler({
      repository,
      config: CONFIG_BASE,
      transport,
      now: () => new Date("2024-01-01T00:00:00.000Z"),
    });

    const resultado = await scheduler.runOnce("posiciones");
    expect(resultado.job).toBe("posiciones");
    expect(resultado.estado).toBe("ok");
    // El resultado quedó registrado en ingest_log.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(resultado);
  });

  it("devuelve un fallo (sin lanzar) cuando la fuente no responde", async () => {
    const { repository, logs } = fakeRepository();
    const transport = {
      async get(): Promise<string> {
        throw new Error("ECONNREFUSED");
      },
    };

    const scheduler = new NodeWorkerIngestScheduler({
      repository,
      config: CONFIG_BASE,
      transport,
    });

    const resultado = await scheduler.runOnce("posiciones");
    expect(resultado.estado).toBe("fallo");
    expect(resultado.fuente).toBe("https://datos/lineasyubicaciones.csv");
    // El fallo de fuente también se registra en ingest_log (Requisito 12.5).
    expect(logs[0].estado).toBe("fallo");
  });

  it("un fallo al registrar en ingest_log no enmascara el resultado del ciclo", async () => {
    const { repository } = fakeRepository({
      async purgePosicionesAntiguas() {
        return 3;
      },
      async logIngesta() {
        throw new Error("ingest_log caído");
      },
    });

    const scheduler = new NodeWorkerIngestScheduler({
      repository,
      config: CONFIG_BASE,
      transport: { async get() { return ""; } },
    });

    const resultado = await scheduler.runOnce("purga");
    expect(resultado.job).toBe("purga");
    expect(resultado.estado).toBe("ok");
  });

  it("el ciclo de calibración no implementado devuelve fallo explicativo sin lanzar", async () => {
    const { repository } = fakeRepository();
    const scheduler = new NodeWorkerIngestScheduler({
      repository,
      config: CONFIG_BASE,
      transport: { async get() { return ""; } },
    });

    const resultado = await scheduler.runOnce("calibracion");
    expect(resultado.estado).toBe("fallo");
    expect(resultado.error).toMatch(/no implementado/);
  });
});

// ---------------------------------------------------------------------------
// start() / stop()
// ---------------------------------------------------------------------------

describe("NodeWorkerIngestScheduler start/stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispara el ciclo de posiciones en cada intervalo y se detiene con stop()", async () => {
    const { repository } = fakeRepository();
    const transport = { get: vi.fn(async () => "") };

    const scheduler = new NodeWorkerIngestScheduler({
      repository,
      config: CONFIG_BASE,
      transport,
      intervalos: { posicionesMs: 1000, purgaMs: 1_000_000, gtfsMs: 1_000_000 },
    });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(3000);
    const llamadasTrasArranque = transport.get.mock.calls.length;
    expect(llamadasTrasArranque).toBeGreaterThanOrEqual(3);

    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(5000);
    // Tras stop() no hay nuevas invocaciones del ciclo de posiciones.
    expect(transport.get.mock.calls.length).toBe(llamadasTrasArranque);
  });

  it("no programa calibración cuando no hay callback conectado", async () => {
    const { repository, logs } = fakeRepository();
    const scheduler = new NodeWorkerIngestScheduler({
      repository,
      config: CONFIG_BASE, // sin config.calibracion
      transport: { async get() { return ""; } },
      intervalos: {
        posicionesMs: 1_000_000,
        purgaMs: 1_000_000,
        gtfsMs: 1_000_000,
        calibracionMs: 1000,
      },
    });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(5000);
    await scheduler.stop();
    // Ningún ciclo de calibración se habría ejecutado/registrado.
    expect(logs.some((l) => l.job === "calibracion")).toBe(false);
  });
});
