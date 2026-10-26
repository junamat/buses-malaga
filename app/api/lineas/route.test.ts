import { describe, it, expect, vi, beforeEach } from "vitest";

import type { Linea } from "@/lib/types";
import type { Pagina, Paginacion, Repository } from "@/lib/ports";

const listLineas = vi.fn();
vi.mock("@/lib/apiRepository", () => ({
  getRepository: (): Pick<Repository, "listLineas"> => ({ listLineas }),
}));

import { GET } from "@/app/api/lineas/route";

function pagina(items: Linea[], next: string | null = null): Pagina<Linea> {
  return { items, next };
}

function req(query = ""): Request {
  return new Request(`http://localhost/api/lineas${query ? `?${query}` : ""}`);
}

beforeEach(() => {
  listLineas.mockReset();
});

describe("GET /api/lineas", () => {
  it("devuelve una FeatureCollection canónica (LineString) con el cursor next", async () => {
    listLineas.mockResolvedValue(
      pagina([{ codLinea: 7, nombre: "Línea 7" }], "1"),
    );

    const res = await GET(req());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.type).toBe("FeatureCollection");
    expect(body.next).toBe("1");
    expect(body.features).toHaveLength(1);

    const feature = body.features[0];
    expect(feature.geometry.type).toBe("LineString");
    // La línea no expone recorrido en este endpoint: geometría sin vértices.
    expect(feature.geometry.coordinates).toEqual([]);
    expect(feature.properties.codLinea).toBe(7);
    expect(feature.properties.nombre).toBe("Línea 7");
  });

  it("omite nombre cuando la línea no lo tiene", async () => {
    listLineas.mockResolvedValue(pagina([{ codLinea: 13 }]));

    const res = await GET(req());
    const body = await res.json();
    expect(body.features[0].properties.codLinea).toBe(13);
    expect(body.features[0].properties).not.toHaveProperty("nombre");
  });

  it("reenvía la paginación (11.3)", async () => {
    listLineas.mockResolvedValue(pagina([]));

    await GET(req("limite=100&cursor=100"));

    const paginacion = listLineas.mock.calls[0][0] as Paginacion;
    expect(paginacion.limite).toBe(100);
    expect(paginacion.cursor).toBe("100");
  });

  it("responde 400 canónico ante un limite malformado (11.8)", async () => {
    const res = await GET(req("limite=x"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("peticion_malformada");
    expect(listLineas).not.toHaveBeenCalled();
  });
});
