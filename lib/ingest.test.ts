import { describe, it, expect, vi } from "vitest";

import {
  parsearLineasCsv,
  ingerirPosiciones,
  type IngestDeps,
} from "@/lib/ingest";
import { parsearPosiciones } from "@/lib/normalize";
import type { HttpTransport, Repository } from "@/lib/ports";

// ---------------------------------------------------------------------------
// parsearLineasCsv — el CSV de posiciones de la EMT llega entrecomillado
// ---------------------------------------------------------------------------

/**
 * Muestra real del CSV `lineasyubicaciones.csv`: fila de cabecera y campos
 * entre comillas dobles. La regresión que esto cubre: con los campos
 * entrecomillados sin recortar, `parseInteger('"640"')` daba NaN y TODAS las
 * filas se descartaban (0 inserciones, ciclo "ok" silencioso).
 */
const CSV_POSICIONES_ENTRECOMILLADO = [
  '"codBus","codLinea","sentido","lon","lat","codParIni","last_update"',
  '"640","1.0","2","-4.4215336","36.717857","253","2026-10-25 15:00:10"',
  '"643","1.0","2","-4.422669","36.73691","112","2026-10-25 15:00:10"',
].join("\n");

describe("parsearLineasCsv", () => {
  it("recorta las comillas dobles que envuelven cada campo", () => {
    const filas = parsearLineasCsv(CSV_POSICIONES_ENTRECOMILLADO);
    // Incluye la cabecera como primera fila (la descarta normalize por no numérica).
    expect(filas[1]).toEqual([
      "640",
      "1.0",
      "2",
      "-4.4215336",
      "36.717857",
      "253",
      "2026-10-25 15:00:10",
    ]);
  });

  it("deja intactos los campos sin comillas (CSV plano)", () => {
    const filas = parsearLineasCsv("640,1,2,-4.42,36.71");
    expect(filas[0]).toEqual(["640", "1", "2", "-4.42", "36.71"]);
  });

  it("produce capturas válidas desde el CSV entrecomillado (no 0 filas)", () => {
    const filas = parsearLineasCsv(CSV_POSICIONES_ENTRECOMILLADO);
    const { validas, descartadas } = parsearPosiciones(
      filas,
      "2026-10-25T15:00:10.000Z",
    );
    // La cabecera se descarta; las dos filas de datos son válidas.
    expect(validas).toHaveLength(2);
    expect(validas[0]).toMatchObject({
      codBus: 640,
      codLinea: 1,
      sentido: 2,
      lon: -4.4215336,
      lat: 36.717857,
      codParIni: "253",
    });
    // Solo la cabecera queda descartada.
    expect(descartadas).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ingerirPosiciones — reintento acotado del fetch ante fallo transitorio
// ---------------------------------------------------------------------------

const CSV_UNA_FILA = [
  '"codBus","codLinea","sentido","lon","lat","codParIni","last_update"',
  '"640","1.0","2","-4.42","36.71","253","2026-10-25 15:00:10"',
].join("\n");

/** Repositorio doble: registra las capturas insertadas, sin BD real. */
function fakeRepo(): { repo: Repository; insertadas: number[] } {
  const insertadas: number[] = [];
  const repo = {
    insertPosiciones: async (capturas: unknown[]) => {
      insertadas.push(capturas.length);
    },
  } as unknown as Repository;
  return { repo, insertadas };
}

/** `IngestDeps` con transporte dado, repo doble y `sleep` no-op (sin esperas). */
function depsCon(transportGet: HttpTransport["get"]): {
  deps: IngestDeps;
  insertadas: number[];
  sleep: ReturnType<typeof vi.fn>;
} {
  const { repo, insertadas } = fakeRepo();
  const sleep = vi.fn(async () => {});
  const deps: IngestDeps = {
    transport: { get: transportGet },
    repository: repo,
    now: () => new Date("2026-10-25T15:00:10.000Z"),
    sleep,
  };
  return { deps, insertadas, sleep };
}

describe("ingerirPosiciones (reintento del fetch)", () => {
  it("reintenta una vez y tiene éxito tras un fallo transitorio", async () => {
    const get = vi.fn<HttpTransport["get"]>()
      .mockRejectedValueOnce(new Error("fetch failed — ECONNRESET"))
      .mockResolvedValueOnce(CSV_UNA_FILA);
    const { deps, insertadas, sleep } = depsCon(get);

    const { resultado, insertadas: n } = await ingerirPosiciones(deps, {
      fuenteUrl: "https://datos/csv",
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(resultado.estado).toBe("ok");
    expect(n).toBe(1);
    expect(insertadas).toEqual([1]);
  });

  it("agota los intentos y reporta el error del último con los datos intactos", async () => {
    const get = vi.fn<HttpTransport["get"]>()
      .mockRejectedValueOnce(new Error("primer fallo"))
      .mockRejectedValueOnce(new Error("ultimo fallo"));
    const { deps, insertadas } = depsCon(get);

    const { resultado, insertadas: n } = await ingerirPosiciones(deps, {
      fuenteUrl: "https://datos/csv",
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect(resultado.estado).toBe("fallo");
    // Se conserva el error del último intento, no el del primero.
    expect(resultado.error).toBe("ultimo fallo");
    expect(resultado.fuente).toBe("https://datos/csv");
    expect(n).toBe(0);
    // No se tocó la BD: datos previos intactos.
    expect(insertadas).toEqual([]);
  });

  it("no reintenta cuando el primer intento tiene éxito", async () => {
    const get = vi.fn<HttpTransport["get"]>()
      .mockResolvedValue(CSV_UNA_FILA);
    const { deps, sleep } = depsCon(get);

    const { resultado } = await ingerirPosiciones(deps, {
      fuenteUrl: "https://datos/csv",
    });

    expect(get).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(resultado.estado).toBe("ok");
  });

  it("intentos ≤ 1 desactiva el reintento", async () => {
    const get = vi.fn<HttpTransport["get"]>()
      .mockRejectedValue(new Error("fallo"));
    const { deps, sleep } = depsCon(get);

    const { resultado } = await ingerirPosiciones(deps, {
      fuenteUrl: "https://datos/csv",
      intentos: 1,
    });

    expect(get).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(resultado.estado).toBe("fallo");
  });
});
