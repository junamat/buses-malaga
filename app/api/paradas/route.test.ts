import { describe, it, expect, vi, beforeEach } from "vitest";

import type { Parada } from "@/lib/types";
import type { Pagina, Paginacion, Repository } from "@/lib/ports";

const listParadas = vi.fn();
vi.mock("@/lib/apiRepository", () => ({
  getRepository: (): Pick<Repository, "listParadas"> => ({ listParadas }),
}));

import { GET } from "@/app/api/paradas/route";

function parada(codParada: string): Parada {
  return { codParada, nombre: `Parada ${codParada}`, lon: -4.42, lat: 36.72 };
}

function pagina(items: Parada[], next: string | null = null): Pagina<Parada> {
  return { items, next };
}

function req(query = ""): Request {
  return new Request(`http://localhost/api/paradas${query ? `?${query}` : ""}`);
}

beforeEach(() => {
  listParadas.mockReset();
});

describe("GET /api/paradas", () => {
  it("devuelve una FeatureCollection GeoJSON canónica con el cursor next", async () => {
    listParadas.mockResolvedValue(pagina([parada("590")], "1"));

    const res = await GET(req());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.type).toBe("FeatureCollection");
    expect(body.next).toBe("1");
    expect(body.features).toHaveLength(1);

    const feature = body.features[0];
    expect(feature.geometry.type).toBe("Point");
    expect(feature.geometry.coordinates).toEqual([-4.42, 36.72]);
    expect(feature.properties.codParada).toBe("590");
    expect(feature.properties.nombre).toBe("Parada 590");
  });

  it("filtra por una única codLinea (3.1)", async () => {
    listParadas.mockResolvedValue(pagina([]));

    await GET(req("codLinea=7"));

    expect(listParadas).toHaveBeenCalledTimes(1);
    expect(listParadas.mock.calls[0][0]).toEqual({ codLinea: 7 });
  });

  it("no pasa filtro cuando no se indica codLinea", async () => {
    listParadas.mockResolvedValue(pagina([]));

    await GET(req());

    expect(listParadas.mock.calls[0][0]).toBeUndefined();
  });

  it("reenvía la paginación (11.3)", async () => {
    listParadas.mockResolvedValue(pagina([]));

    await GET(req("limite=200&cursor=400"));

    const paginacion = listParadas.mock.calls[0][1] as Paginacion;
    expect(paginacion.limite).toBe(200);
    expect(paginacion.cursor).toBe("400");
  });

  it("responde 400 canónico ante codLinea malformado (11.8)", async () => {
    const res = await GET(req("codLinea=abc"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("peticion_malformada");
    expect(listParadas).not.toHaveBeenCalled();
  });
});
