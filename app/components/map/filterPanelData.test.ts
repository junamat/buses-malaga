import { afterEach, describe, it, expect, vi } from "vitest";

import {
  fetchLineas,
  resolverSentidosConDestino,
  type LineaOpcion,
  type SentidoEtiqueta,
} from "./filterPanelData";
import type {
  LineaFeatureProperties,
  GeoJSONFeatureCollection,
  GeoJSONLineString,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

type LineaPage = GeoJSONFeatureCollection<
  LineaFeatureProperties,
  GeoJSONLineString
> & { next: string | null };

function lineaFeature(props: LineaFeatureProperties) {
  return {
    type: "Feature" as const,
    geometry: { type: "LineString" as const, coordinates: [] },
    properties: props,
  };
}

/** Instala un `fetch` mock que devuelve una única página de líneas. */
function mockLineaPage(features: LineaPage["features"]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const page: LineaPage = {
        type: "FeatureCollection",
        features,
        next: null,
      };
      return { ok: true, status: 200, json: async () => page } as Response;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SENTIDOS_BASE: readonly SentidoEtiqueta[] = [
  { sentido: 1, etiqueta: "Ida" },
  { sentido: 2, etiqueta: "Vuelta" },
];

// ---------------------------------------------------------------------------
// fetchLineas: colapso de Features por Sentido en una opción por línea
// ---------------------------------------------------------------------------

describe("fetchLineas", () => {
  it("colapsa los Features por Sentido de una línea en una sola opción con sus destinos", async () => {
    mockLineaPage([
      lineaFeature({ codLinea: 7, nombre: "Línea 7", sentido: 1, destino: "San Andrés" }),
      lineaFeature({ codLinea: 7, nombre: "Línea 7", sentido: 2, destino: "Centro" }),
    ]);

    const opciones = await fetchLineas();
    expect(opciones).toHaveLength(1);
    expect(opciones[0]).toMatchObject({
      codLinea: 7,
      nombre: "Línea 7",
      destinos: { 1: "San Andrés", 2: "Centro" },
    });
  });

  it("deja destinos vacío para una línea expuesta sin sentido ni destino", async () => {
    mockLineaPage([lineaFeature({ codLinea: 13, nombre: "Línea 13" })]);

    const opciones = await fetchLineas();
    expect(opciones).toHaveLength(1);
    expect(opciones[0].codLinea).toBe(13);
    expect(opciones[0].destinos).toEqual({});
  });

  it("ordena por codLinea ascendente y descarta códigos no numéricos", async () => {
    mockLineaPage([
      lineaFeature({ codLinea: 12 }),
      lineaFeature({ codLinea: 3 }),
      // Salvaguarda: código no numérico se descarta.
      lineaFeature({ codLinea: undefined as unknown as number }),
    ]);

    const opciones = await fetchLineas();
    expect(opciones.map((o) => o.codLinea)).toEqual([3, 12]);
  });

  it("ignora un destino vacío al construir el mapa de destinos", async () => {
    mockLineaPage([
      lineaFeature({ codLinea: 7, sentido: 1, destino: "" }),
      lineaFeature({ codLinea: 7, sentido: 2, destino: "Centro" }),
    ]);

    const opciones = await fetchLineas();
    expect(opciones[0].destinos).toEqual({ 2: "Centro" });
  });
});

// ---------------------------------------------------------------------------
// resolverSentidosConDestino (Requisito 2.8)
// ---------------------------------------------------------------------------

describe("resolverSentidosConDestino", () => {
  const lineas: readonly LineaOpcion[] = [
    { codLinea: 7, nombre: "Línea 7", destinos: { 1: "San Andrés", 2: "Centro" } },
    { codLinea: 8, nombre: "Línea 8", destinos: { 1: "El Palo" } },
    { codLinea: 9, nombre: "Línea 9", destinos: {} },
  ];

  it("sin líneas seleccionadas, conserva las etiquetas base sin destino", () => {
    const res = resolverSentidosConDestino(SENTIDOS_BASE, lineas, new Set());
    expect(res).toEqual([
      { sentido: 1, etiqueta: "Ida" },
      { sentido: 2, etiqueta: "Vuelta" },
    ]);
  });

  it("con una única línea seleccionada, muestra su destino por sentido", () => {
    const res = resolverSentidosConDestino(SENTIDOS_BASE, lineas, new Set([7]));
    expect(res).toEqual([
      { sentido: 1, etiqueta: "Ida", destino: "San Andrés" },
      { sentido: 2, etiqueta: "Vuelta", destino: "Centro" },
    ]);
  });

  it("omite el destino del sentido que la línea seleccionada no tiene", () => {
    const res = resolverSentidosConDestino(SENTIDOS_BASE, lineas, new Set([8]));
    expect(res[0]).toEqual({ sentido: 1, etiqueta: "Ida", destino: "El Palo" });
    // La línea 8 no tiene destino para el sentido 2 ⇒ solo el sentido.
    expect(res[1]).toEqual({ sentido: 2, etiqueta: "Vuelta" });
  });

  it("si las líneas seleccionadas discrepan en un sentido, no muestra destino", () => {
    const lineasDiscrepantes: readonly LineaOpcion[] = [
      { codLinea: 1, destinos: { 1: "Norte" } },
      { codLinea: 2, destinos: { 1: "Sur" } },
    ];
    const res = resolverSentidosConDestino(
      SENTIDOS_BASE,
      lineasDiscrepantes,
      new Set([1, 2]),
    );
    expect(res[0]).toEqual({ sentido: 1, etiqueta: "Ida" });
  });

  it("si las líneas seleccionadas coinciden en el mismo destino, lo muestra", () => {
    const lineasCoincidentes: readonly LineaOpcion[] = [
      { codLinea: 1, destinos: { 1: "Centro" } },
      { codLinea: 2, destinos: { 1: "Centro" } },
    ];
    const res = resolverSentidosConDestino(
      SENTIDOS_BASE,
      lineasCoincidentes,
      new Set([1, 2]),
    );
    expect(res[0]).toEqual({ sentido: 1, etiqueta: "Ida", destino: "Centro" });
  });

  it("una línea sin destinos seleccionada no aporta texto de destino", () => {
    const res = resolverSentidosConDestino(SENTIDOS_BASE, lineas, new Set([9]));
    expect(res).toEqual([
      { sentido: 1, etiqueta: "Ida" },
      { sentido: 2, etiqueta: "Vuelta" },
    ]);
  });
});
