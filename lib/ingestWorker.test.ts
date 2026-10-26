import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

import type { IngestJob, Repository } from "@/lib/ports";

const runOnce = vi.fn();
const start = vi.fn();
const stop = vi.fn();
const listLineas = vi.fn();

vi.mock("@/lib/apiRepository", () => ({
  getRepository: () => ({ listLineas } as unknown as Repository),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...real,
    createIngestScheduler: () => ({
      transport: { get: async () => "" },
      runOnce: (job: IngestJob) => runOnce(job),
      start: () => start(),
      stop: () => stop(),
    }),
  };
});

import { iniciarWorkerIngesta, detenerWorkerIngesta } from "@/lib/ingestWorker";

const ENV_LOCAL = {
  BACKEND_PROVIDER: "local-postgres",
  DATABASE_URL: "postgresql://x@127.0.0.1:5432/db",
  INGEST_WORKER_ENABLED: "true",
};

/** Espera a que terminen las ejecuciones iniciales lanzadas en segundo plano. */
const vaciarMicrotareas = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  runOnce.mockReset().mockResolvedValue({ estado: "ok" });
  start.mockReset().mockResolvedValue(undefined);
  stop.mockReset().mockResolvedValue(undefined);
  listLineas.mockReset().mockResolvedValue({ items: [{ codLinea: 1 }], next: null });
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(async () => {
  await detenerWorkerIngesta();
  vi.restoreAllMocks();
});

describe("iniciarWorkerIngesta", () => {
  it("no arranca si INGEST_WORKER_ENABLED no es 'true'", async () => {
    const s = await iniciarWorkerIngesta({ ...ENV_LOCAL, INGEST_WORKER_ENABLED: "false" });
    expect(s).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("no arranca fuera de local-postgres", async () => {
    const s = await iniciarWorkerIngesta({
      ...ENV_LOCAL,
      BACKEND_PROVIDER: "supabase-cloud",
      SUPABASE_URL: "http://x",
      SUPABASE_ANON_KEY: "k",
    });
    expect(s).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("arranca los temporizadores y ejecuta posiciones y purga de inmediato", async () => {
    const s = await iniciarWorkerIngesta(ENV_LOCAL);
    await vaciarMicrotareas();
    expect(s).not.toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(runOnce.mock.calls.map((c) => c[0])).toEqual(["posiciones", "purga"]);
  });

  it("lanza la recarga GTFS inicial si la base no tiene líneas", async () => {
    listLineas.mockResolvedValue({ items: [], next: null });
    await iniciarWorkerIngesta(ENV_LOCAL);
    await vaciarMicrotareas();
    expect(runOnce.mock.calls.map((c) => c[0])).toEqual(["gtfs", "posiciones", "purga"]);
  });

  it("es idempotente dentro del mismo proceso", async () => {
    const a = await iniciarWorkerIngesta(ENV_LOCAL);
    const b = await iniciarWorkerIngesta(ENV_LOCAL);
    expect(a).toBe(b);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
