import { describe, it, expect, vi, beforeEach } from "vitest";

import type { Bus } from "@/lib/types";
import type { FiltroPosiciones, Pagina, Paginacion, Repository } from "@/lib/ports";

// El handler resuelve el repositorio vía `getRepository`; lo sustituimos por un
// doble para probar la lógica del route handler sin tocar Postgres.
const listBuses = vi.fn();
const listDestinos = vi.fn();
vi.mock("@/lib/apiRepository", () => ({
  getRepository: (): Pick<Repository, "listBuses" | "listDestinos"> => ({
    listBuses,
    listDestinos,
  }),
}));

import { GET } from "@/app/api/buses/route";

const BUS_BASE: Omit<Bus, "codBus" | "codLinea" | "sentido"> = {
  lon: -4.42,
  lat: 36.72,
  last_update: "2024-01-01T12:00:00.000Z",
  captured_at: "2024-01-01T12:00:00.000Z",
};

function bus(codBus: number, codLinea: number, sentido: number): Bus {
  return { ...BUS_BASE, codBus, codLinea, sentido };
}

function pagina(items: Bus[], next: string | null = null): Pagina<Bus> {
  return { items, next };
}

function req(query = ""): Request {
  return new Request(`http://localhost/api/buses${query ? `?${query}` : ""}`);
}

beforeEach(() => {
  listBuses.mockReset();
  listDestinos.mockReset();
  listDestinos.mockResolvedValue([]);
});

describe("GET /api/buses", () => {
  it("devuelve una FeatureCollection GeoJSON canónica con el cursor next", async () => {
    listBuses.mockResolvedValue(pagina([bus(100, 7, 1)], "1"));

    const res = await GET(req());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.type).toBe("FeatureCollection");
    expect(body.next).toBe("1");
    expect(body.features).toHaveLength(1);

    const feature = body.features[0];
    expect(feature.type).toBe("Feature");
    expect(feature.geometry.type).toBe("Point");
    // Coordenadas numéricas en orden [lon, lat].
    expect(feature.geometry.coordinates).toEqual([-4.42, 36.72]);
    expect(feature.properties.codBus).toBe(100);
    expect(feature.properties.codLinea).toBe(7);
    expect(feature.properties.sentido).toBe(1);
    expect(feature.properties).toHaveProperty("obsoleto");
  });

  it("pasa el filtro AND por codLinea y sentido al repositorio (3.1, 3.2, 3.3)", async () => {
    listBuses.mockResolvedValue(pagina([]));

    await GET(req("codLinea=1,7&sentido=2"));

    expect(listBuses).toHaveBeenCalledTimes(1);
    const filtro = listBuses.mock.calls[0][0] as FiltroPosiciones;
    expect(filtro.codLineas).toEqual([1, 7]);
    expect(filtro.sentido).toBe(2);
  });

  it("no incluye filtros ausentes", async () => {
    listBuses.mockResolvedValue(pagina([]));

    await GET(req());

    const filtro = listBuses.mock.calls[0][0] as FiltroPosiciones;
    expect(filtro.codLineas).toBeUndefined();
    expect(filtro.sentido).toBeUndefined();
  });

  it("reenvía limite y cursor como paginación (11.3)", async () => {
    listBuses.mockResolvedValue(pagina([]));

    await GET(req("limite=50&cursor=200"));

    const paginacion = listBuses.mock.calls[0][1] as Paginacion;
    expect(paginacion.limite).toBe(50);
    expect(paginacion.cursor).toBe("200");
  });

  it("hereda el destino del (codLinea, sentido) de cada Bus y lo omite si no existe (2.8, 11.10)", async () => {
    listBuses.mockResolvedValue(
      pagina([bus(100, 7, 1), bus(101, 7, 2), bus(102, 3, 1)]),
    );
    // Solo (7,1) y (7,2) tienen Destino; (3,1) no.
    listDestinos.mockResolvedValue([
      { codLinea: 7, sentido: 1, destino: "San Andrés" },
      { codLinea: 7, sentido: 2, destino: "Centro" },
    ]);

    const res = await GET(req());
    const body = await res.json();

    const [f71, f72, f31] = body.features;
    expect(f71.properties.destino).toBe("San Andrés");
    expect(f72.properties.destino).toBe("Centro");
    // (3,1) no tiene Destino: la propiedad se omite, no se emite vacía ni null.
    expect(f31.properties).not.toHaveProperty("destino");
  });

  it("propaga el filtro de líneas a la consulta de destinos", async () => {
    listBuses.mockResolvedValue(pagina([]));

    await GET(req("codLinea=1,7"));

    expect(listDestinos).toHaveBeenCalledTimes(1);
    expect(listDestinos.mock.calls[0][0]).toEqual({ codLineas: [1, 7] });
  });

  it("consulta todos los destinos cuando no hay filtro de líneas", async () => {
    listBuses.mockResolvedValue(pagina([]));

    await GET(req());

    expect(listDestinos).toHaveBeenCalledTimes(1);
    expect(listDestinos.mock.calls[0][0]).toBeUndefined();
  });

  it("responde 400 canónico ante un codLinea malformado (11.8)", async () => {
    const res = await GET(req("codLinea=abc"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("peticion_malformada");
    expect(listBuses).not.toHaveBeenCalled();
  });

  it("responde 400 canónico ante un limite malformado (11.8)", async () => {
    const res = await GET(req("limite=x"));
    expect(res.status).toBe(400);
    expect(listBuses).not.toHaveBeenCalled();
  });
});
