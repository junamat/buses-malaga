import { afterEach, describe, it, expect, vi } from "vitest";
import fc from "fast-check";

import {
  anyStale,
  describeStaleness,
  fetchBuses,
  fetchParadas,
  formatAge,
  maxCaptureAgeMs,
  type BusFeature,
  type ParadaFeature,
} from "./busLayerData";
import type {
  BusFeatureProperties,
  ParadaFeatureProperties,
  GeoJSONFeatureCollection,
  GeoJSONPoint,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Ayudas para construir features de prueba
// ---------------------------------------------------------------------------

function busFeature(
  props: Partial<BusFeatureProperties> & { captured_at: string },
): BusFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-4.42, 36.72] },
    properties: {
      codBus: 1,
      codLinea: 7,
      sentido: 1,
      last_update: props.captured_at,
      obsoleto: false,
      ...props,
    },
  };
}

function paradaFeature(codParada: string, nombre: string): ParadaFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-4.42, 36.72] },
    properties: { codParada, nombre },
  };
}

type BusPage = GeoJSONFeatureCollection<BusFeatureProperties, GeoJSONPoint> & {
  next: string | null;
};
type ParadaPage = GeoJSONFeatureCollection<
  ParadaFeatureProperties,
  GeoJSONPoint
> & { next: string | null };

/** Instala un `fetch` mock que devuelve las páginas indicadas en orden. */
function mockFetchPages(pages: Array<BusPage | ParadaPage>): void {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const page = pages[Math.min(i, pages.length - 1)];
      i += 1;
      return {
        ok: true,
        status: 200,
        json: async () => page,
      } as Response;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// formatAge
// ---------------------------------------------------------------------------

describe("formatAge", () => {
  it("formatea segundos, minutos y horas de forma legible", () => {
    expect(formatAge(0)).toBe("0 s");
    expect(formatAge(45_000)).toBe("45 s");
    expect(formatAge(59_999)).toBe("59 s");
    expect(formatAge(60_000)).toBe("1 min");
    expect(formatAge(3 * 60_000)).toBe("3 min");
    expect(formatAge(60 * 60_000)).toBe("1 h");
    expect(formatAge(65 * 60_000)).toBe("1 h 5 min");
  });

  it("trata antigüedades negativas como 0 s", () => {
    expect(formatAge(-5_000)).toBe("0 s");
  });

  it("nunca produce cadena vacía para antigüedades no negativas", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), (ms) => {
        expect(formatAge(ms).length).toBeGreaterThan(0);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// maxCaptureAgeMs / anyStale
// ---------------------------------------------------------------------------

describe("maxCaptureAgeMs", () => {
  it("devuelve null cuando no hay buses", () => {
    expect(maxCaptureAgeMs([], Date.now())).toBeNull();
  });

  it("devuelve la antigüedad de la captura más antigua mostrada", () => {
    const now = Date.parse("2024-01-01T00:02:00Z");
    const buses = [
      busFeature({ codBus: 1, captured_at: "2024-01-01T00:01:30Z" }), // 30 s
      busFeature({ codBus: 2, captured_at: "2024-01-01T00:00:00Z" }), // 120 s
    ];
    expect(maxCaptureAgeMs(buses, now)).toBe(120_000);
  });

  it("ignora marcas no parseables pero usa las válidas", () => {
    const now = Date.parse("2024-01-01T00:01:00Z");
    const buses = [
      busFeature({ codBus: 1, captured_at: "no-es-fecha" }),
      busFeature({ codBus: 2, captured_at: "2024-01-01T00:00:30Z" }),
    ];
    expect(maxCaptureAgeMs(buses, now)).toBe(30_000);
  });
});

describe("anyStale", () => {
  it("detecta si algún bus está marcado como obsoleto", () => {
    expect(anyStale([])).toBe(false);
    expect(
      anyStale([busFeature({ captured_at: "2024-01-01T00:00:00Z" })]),
    ).toBe(false);
    expect(
      anyStale([
        busFeature({ captured_at: "2024-01-01T00:00:00Z", obsoleto: true }),
      ]),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describeStaleness (Requisito 2.7)
// ---------------------------------------------------------------------------

describe("describeStaleness", () => {
  it("devuelve null cuando no hay buses", () => {
    expect(describeStaleness([], Date.now())).toBeNull();
  });

  it("devuelve null cuando ningún bus es obsoleto", () => {
    const buses = [busFeature({ captured_at: "2024-01-01T00:00:00Z" })];
    expect(describeStaleness(buses, Date.parse("2024-01-01T00:00:30Z"))).toBeNull();
  });

  it("describe la antigüedad cuando hay datos obsoletos", () => {
    const now = Date.parse("2024-01-01T00:05:00Z");
    const buses = [
      busFeature({
        codBus: 1,
        captured_at: "2024-01-01T00:00:00Z",
        obsoleto: true,
      }),
    ];
    const msg = describeStaleness(buses, now);
    expect(msg).not.toBeNull();
    expect(msg).toContain("obsoletos");
    expect(msg).toContain("5 min");
  });
});

// ---------------------------------------------------------------------------
// fetchBuses / fetchParadas: seguimiento del cursor de paginación
// ---------------------------------------------------------------------------

describe("fetchBuses", () => {
  it("concatena todas las páginas siguiendo el cursor next", async () => {
    const page1: BusPage = {
      type: "FeatureCollection",
      features: [busFeature({ codBus: 1, captured_at: "2024-01-01T00:00:00Z" })],
      next: "cursor-2",
    };
    const page2: BusPage = {
      type: "FeatureCollection",
      features: [busFeature({ codBus: 2, captured_at: "2024-01-01T00:00:00Z" })],
      next: null,
    };
    mockFetchPages([page1, page2]);

    const buses = await fetchBuses();
    expect(buses.map((b) => b.properties.codBus)).toEqual([1, 2]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("incluye los filtros de línea y sentido en la query", async () => {
    const vacio: BusPage = {
      type: "FeatureCollection",
      features: [],
      next: null,
    };
    mockFetchPages([vacio]);

    await fetchBuses({ codLineas: [1, 7], sentido: 2 });
    const url = (fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(url).toContain("/api/buses?");
    expect(url).toContain("codLinea=1%2C7");
    expect(url).toContain("sentido=2");
  });

  it("lanza error cuando la respuesta no es ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 }) as Response),
    );
    await expect(fetchBuses()).rejects.toThrow();
  });
});

describe("fetchParadas", () => {
  it("sigue el cursor y filtra por línea cuando se indica", async () => {
    const page1: ParadaPage = {
      type: "FeatureCollection",
      features: [paradaFeature("1", "Alameda")],
      next: "c2",
    };
    const page2: ParadaPage = {
      type: "FeatureCollection",
      features: [paradaFeature("2", "Marqués")],
      next: null,
    };
    mockFetchPages([page1, page2]);

    const paradas = await fetchParadas(7);
    expect(paradas.map((p) => p.properties.codParada)).toEqual(["1", "2"]);
    const url = (fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(url).toContain("codLinea=7");
  });
});
