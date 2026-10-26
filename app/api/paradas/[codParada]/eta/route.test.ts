/**
 * Test del contrato HTTP del endpoint de ETA (tarea 10.5).
 *
 * - Property 34: ETA inexistente responde con éxito e indicador de no disponible.
 *   Validates: Requirement 11.6.
 * - 404 cuando la parada no existe (Requisito 11.7).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { Eta, Parada } from "@/lib/types";
import type { Repository } from "@/lib/ports";

const findParada = vi.fn();
const etaPorParada = vi.fn();
vi.mock("@/lib/apiRepository", () => ({
  getRepository: (): Pick<Repository, "findParada" | "etaPorParada"> => ({
    findParada,
    etaPorParada,
  }),
}));

import { GET } from "@/app/api/paradas/[codParada]/eta/route";

function ctx(codParada: string): { params: { codParada: string } } {
  return { params: { codParada } };
}

function req(): Request {
  return new Request("http://localhost/api/paradas/590/eta");
}

const parada: Parada = {
  codParada: "590",
  nombre: "Parada 590",
  lon: -4.42,
  lat: 36.72,
};

beforeEach(() => {
  findParada.mockReset();
  etaPorParada.mockReset();
});

describe("GET /api/paradas/{codParada}/eta", () => {
  it("devuelve 200 con las estimaciones por línea cuando la parada existe", async () => {
    findParada.mockResolvedValue(parada);
    const etas: Eta[] = [
      { codLinea: 3, sentido: 1, minutos: 5, disponible: true, margenMinutos: 1 },
    ];
    etaPorParada.mockResolvedValue(etas);

    const res = await GET(req(), ctx("590"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.codParada).toBe("590");
    expect(body.etas).toEqual(etas);
  });

  it("Property 34: parada sin ETA responde 200 con disponible=false", async () => {
    findParada.mockResolvedValue(parada);
    const etas: Eta[] = [
      {
        codLinea: 3,
        sentido: 1,
        minutos: null,
        disponible: false,
        motivo: "No hay buses vigentes.",
      },
    ];
    etaPorParada.mockResolvedValue(etas);

    const res = await GET(req(), ctx("590"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.etas[0].disponible).toBe(false);
    expect(body.etas[0].minutos).toBeNull();
    expect(body.etas[0].motivo).toBeTypeOf("string");
  });

  it("devuelve 200 con lista vacía cuando ninguna línea sirve la parada", async () => {
    findParada.mockResolvedValue(parada);
    etaPorParada.mockResolvedValue([]);

    const res = await GET(req(), ctx("590"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.etas).toEqual([]);
  });

  it("devuelve 404 canónico cuando la parada no existe (11.7)", async () => {
    findParada.mockResolvedValue(null);

    const res = await GET(req(), ctx("000"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("no_encontrado");
    expect(etaPorParada).not.toHaveBeenCalled();
  });

  it("devuelve 400 de parámetros ausentes si codParada viene vacío (11.9)", async () => {
    const res = await GET(req(), ctx("  "));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("parametros_obligatorios_ausentes");
    expect(findParada).not.toHaveBeenCalled();
  });
});
