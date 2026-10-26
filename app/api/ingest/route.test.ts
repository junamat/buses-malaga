import { describe, it, expect, vi, beforeEach } from "vitest";

import type {
  BackendConfig,
  BackendProvider,
} from "@/lib/config";
import type {
  IngestJob,
  IngestResult,
  IngestScheduler,
  Repository,
} from "@/lib/ports";

// El handler resuelve config + repositorio + scheduler vía la factoría de
// `@/lib/config`. Mockeamos esas funciones para probar el route handler sin
// tocar Postgres ni instanciar adaptadores reales. En particular, el endpoint
// NO debe construir el backend completo (que crearía el AuthProvider aún no
// implementado); solo necesita el repositorio y el scheduler de ingesta.
const loadBackendConfig = vi.fn();
const getRepository = vi.fn();
const createIngestScheduler = vi.fn();

vi.mock("@/lib/config", () => ({
  loadBackendConfig: () => loadBackendConfig(),
  createIngestScheduler: (config: BackendConfig, repo: Repository) =>
    createIngestScheduler(config, repo),
}));

// El repositorio se obtiene del helper memoizado por proceso (pool compartido).
vi.mock("@/lib/apiRepository", () => ({
  getRepository: () => getRepository(),
}));

import { POST } from "@/app/api/ingest/route";

// ---------------------------------------------------------------------------
// Dobles
// ---------------------------------------------------------------------------

const runOnce = vi.fn();

function schedulerDoble(): IngestScheduler {
  return {
    transport: { async get() { return ""; } },
    runOnce: (job: IngestJob) => runOnce(job),
    async start() {},
    async stop() {},
  } as unknown as IngestScheduler;
}

function configDoble(provider: BackendProvider): BackendConfig {
  return {
    provider,
    databaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/buses_malaga",
    devUserEnabled: true,
    ingest: {
      posicionesFuenteUrl: "https://datos/lineasyubicaciones.csv",
      workerEnabled: false,
    },
  };
}

function resultadoOk(job: IngestJob): IngestResult {
  return {
    job,
    estado: "ok",
    fuente: "https://datos/lineasyubicaciones.csv",
  } as unknown as IngestResult;
}

function req(body?: unknown): Request {
  return new Request("http://localhost/api/ingest", {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  loadBackendConfig.mockReset();
  getRepository.mockReset();
  createIngestScheduler.mockReset();
  runOnce.mockReset();

  // Camino feliz por defecto: modo local-postgres con scheduler funcional.
  loadBackendConfig.mockReturnValue(configDoble("local-postgres"));
  getRepository.mockReturnValue({} as Repository);
  createIngestScheduler.mockReturnValue(schedulerDoble());
});

describe("POST /api/ingest", () => {
  it("dispara el ciclo por defecto (posiciones) y devuelve el resultado con 200", async () => {
    runOnce.mockResolvedValue(resultadoOk("posiciones"));

    const res = await POST(req());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.job).toBe("posiciones");
    expect(body.estado).toBe("ok");
    expect(runOnce).toHaveBeenCalledWith("posiciones");
  });

  it("no construye el backend completo: solo repositorio + scheduler (sin AuthProvider)", async () => {
    runOnce.mockResolvedValue(resultadoOk("posiciones"));

    await POST(req());

    // El endpoint debe ser alcanzable en local-postgres sin instanciar el
    // AuthProvider (adaptador del Hito 3). Confirmamos que se usó la factoría
    // granular y se llegó al scheduler.
    expect(getRepository).toHaveBeenCalledTimes(1);
    expect(createIngestScheduler).toHaveBeenCalledTimes(1);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("dispara el ciclo indicado en el cuerpo", async () => {
    runOnce.mockResolvedValue(resultadoOk("purga"));

    const res = await POST(req({ job: "purga" }));
    expect(res.status).toBe(200);
    expect(runOnce).toHaveBeenCalledWith("purga");
  });

  it("devuelve 200 también cuando el ciclo termina en fallo (fallo de fuente)", async () => {
    runOnce.mockResolvedValue({
      job: "posiciones",
      estado: "fallo",
      fuente: "https://datos/lineasyubicaciones.csv",
      error: "ECONNREFUSED",
    } as unknown as IngestResult);

    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.estado).toBe("fallo");
  });

  it("responde 404 en modos distintos de local-postgres (no expuesto en producción)", async () => {
    loadBackendConfig.mockReturnValue(configDoble("supabase-cloud"));

    const res = await POST(req());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("no_encontrado");
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("responde 404 cuando la configuración es inválida", async () => {
    loadBackendConfig.mockImplementation(() => {
      throw new Error("Falta la variable de entorno obligatoria DATABASE_URL");
    });

    const res = await POST(req());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("no_encontrado");
  });

  it("responde 400 ante un job desconocido", async () => {
    const res = await POST(req({ job: "inexistente" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("job_invalido");
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("responde 400 ante un cuerpo no-JSON", async () => {
    const res = new Request("http://localhost/api/ingest", {
      method: "POST",
      body: "{ esto no es json",
    });
    const out = await POST(res);
    expect(out.status).toBe(400);
    const body = await out.json();
    expect(body.code).toBe("peticion_malformada");
  });
});
