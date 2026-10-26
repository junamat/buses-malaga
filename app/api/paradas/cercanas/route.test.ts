/**
 * Test del endpoint de paradas cercanas (tarea 10.2).
 *
 * Verifica la serialización GeoJSON con distancia, el paso de radio/límite
 * fijos al repositorio y el contrato de errores de parámetros obligatorios/
 * malformados (Requisitos 6.2, 6.6, 11.8, 11.9).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ParadaCercana, Repository } from "@/lib/ports";

const findParadasCercanas = vi.fn();
vi.mock("@/lib/apiRepository", () => ({
  getRepository: (): Pick<Repository, "findParadasCercanas"> => ({
    findParadasCercanas,
  }),
}));

import { GET } from "@/app/api/paradas/cercanas/route";

function req(query: string): Request {
  return new Request(`http://localhost/api/paradas/cercanas?${query}`);
}

function cercana(cod: string, dist: number): ParadaCercana {
  return {
    codParada: cod,
    nombre: `Parada ${cod}`,
    lon: -4.42,
    lat: 36.72,
    distanciaMetros: dist,
  };
}

beforeEach(() => {
  findParadasCercanas.mockReset();
});

describe("GET /api/paradas/cercanas", () => {
  it("devuelve GeoJSON con distanciaMetros por parada (6.6)", async () => {
    findParadasCercanas.mockResolvedValue([cercana("590", 120.5)]);

    const res = await GET(req("lat=36.72&lon=-4.42"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("FeatureCollection");
    expect(body.features).toHaveLength(1);
    expect(body.features[0].geometry.coordinates).toEqual([-4.42, 36.72]);
    expect(body.features[0].properties.codParada).toBe("590");
    expect(body.features[0].properties.distanciaMetros).toBe(120.5);
  });

  it("pasa radio 1000 m y límite 10 al repositorio (6.2)", async () => {
    findParadasCercanas.mockResolvedValue([]);

    await GET(req("lat=36.72&lon=-4.42"));

    expect(findParadasCercanas).toHaveBeenCalledTimes(1);
    const [lon, lat, radio, limite] = findParadasCercanas.mock.calls[0];
    expect(lon).toBe(-4.42);
    expect(lat).toBe(36.72);
    expect(radio).toBe(1000);
    expect(limite).toBe(10);
  });

  it("responde 400 de parámetros ausentes si falta lat/lon (11.9)", async () => {
    const res = await GET(req("lat=36.72"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("parametros_obligatorios_ausentes");
    expect(body.params).toContain("lon");
    expect(findParadasCercanas).not.toHaveBeenCalled();
  });

  it("responde 400 malformado si lat/lon no son números (11.8)", async () => {
    const res = await GET(req("lat=abc&lon=-4.42"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("peticion_malformada");
    expect(findParadasCercanas).not.toHaveBeenCalled();
  });

  it("responde 400 malformado si lat/lon están fuera de rango (11.8)", async () => {
    const res = await GET(req("lat=200&lon=-4.42"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("peticion_malformada");
  });
});
