import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  buildDestinoLookup,
  destinoKey,
  busToFeature,
  busesToFeatureCollection,
  lineaToFeature,
} from "@/lib/geojson";
import type { Bus, DestinoGtfs } from "@/lib/types";

const BUS_BASE: Omit<Bus, "codBus" | "codLinea" | "sentido"> = {
  lon: -4.42,
  lat: 36.72,
  last_update: "2024-01-01T12:00:00.000Z",
  captured_at: "2024-01-01T12:00:00.000Z",
};

function bus(codBus: number, codLinea: number, sentido: number): Bus {
  return { ...BUS_BASE, codBus, codLinea, sentido };
}

const CTX = { now: "2024-01-01T12:00:00.000Z" } as const;

// ---------------------------------------------------------------------------
// DestinoLookup
// ---------------------------------------------------------------------------

describe("buildDestinoLookup / destinoKey", () => {
  it("indexa por (codLinea, sentido)", () => {
    const lookup = buildDestinoLookup([
      { codLinea: 7, sentido: 1, destino: "San Andrés" },
      { codLinea: 7, sentido: 2, destino: "Centro" },
    ]);
    expect(lookup.get(destinoKey(7, 1))).toBe("San Andrés");
    expect(lookup.get(destinoKey(7, 2))).toBe("Centro");
    expect(lookup.get(destinoKey(3, 1))).toBeUndefined();
  });

  it("la última entrada de un par duplicado prevalece (mapa determinista)", () => {
    const lookup = buildDestinoLookup([
      { codLinea: 7, sentido: 1, destino: "Antiguo" },
      { codLinea: 7, sentido: 1, destino: "Nuevo" },
    ]);
    expect(lookup.get(destinoKey(7, 1))).toBe("Nuevo");
  });
});

// ---------------------------------------------------------------------------
// Bus: herencia del Destino (Requisitos 2.8, 11.10 — Property 41)
// ---------------------------------------------------------------------------

describe("busToFeature: herencia del destino", () => {
  it("incluye el destino del (codLinea, sentido) cuando existe", () => {
    const lookup = buildDestinoLookup([
      { codLinea: 7, sentido: 1, destino: "San Andrés" },
    ]);
    const feature = busToFeature(bus(100, 7, 1), CTX, lookup);
    expect(feature.properties.destino).toBe("San Andrés");
  });

  it("omite la propiedad destino cuando el par no tiene Destino", () => {
    const lookup = buildDestinoLookup([
      { codLinea: 7, sentido: 1, destino: "San Andrés" },
    ]);
    const feature = busToFeature(bus(100, 7, 2), CTX, lookup);
    expect(feature.properties).not.toHaveProperty("destino");
  });

  it("omite la propiedad destino cuando no se aporta lookup", () => {
    const feature = busToFeature(bus(100, 7, 1), CTX);
    expect(feature.properties).not.toHaveProperty("destino");
  });

  it("propaga el lookup a cada Bus de la colección", () => {
    const lookup = buildDestinoLookup([
      { codLinea: 7, sentido: 1, destino: "San Andrés" },
    ]);
    const fc0 = busesToFeatureCollection(
      [bus(100, 7, 1), bus(101, 7, 2)],
      CTX,
      lookup,
    );
    expect(fc0.features[0].properties.destino).toBe("San Andrés");
    expect(fc0.features[1].properties).not.toHaveProperty("destino");
  });

  // Property 41: para todo Bus y todo mapa de Destinos, el Destino expuesto es
  // exactamente el del mapa para su (codLinea, sentido) cuando existe, y la
  // propiedad se omite cuando no. **Validates: Requirements 2.8, 11.10**
  it("el destino expuesto coincide con el mapa, u se omite si no está (Property 41)", () => {
    const arbBus = fc.record({
      codBus: fc.integer({ min: 1, max: 1000 }),
      codLinea: fc.integer({ min: 1, max: 20 }),
      sentido: fc.integer({ min: 1, max: 2 }),
    });
    const arbDestinos = fc.array(
      fc.record({
        codLinea: fc.integer({ min: 1, max: 20 }),
        sentido: fc.integer({ min: 1, max: 2 }),
        destino: fc.string({ minLength: 1, maxLength: 12 }),
      }),
      { maxLength: 30 },
    ) as fc.Arbitrary<DestinoGtfs[]>;

    fc.assert(
      fc.property(arbBus, arbDestinos, (b, destinos) => {
        const lookup = buildDestinoLookup(destinos);
        const feature = busToFeature(bus(b.codBus, b.codLinea, b.sentido), CTX, lookup);
        const esperado = lookup.get(destinoKey(b.codLinea, b.sentido));
        if (esperado === undefined) {
          expect(feature.properties).not.toHaveProperty("destino");
        } else {
          expect(feature.properties.destino).toBe(esperado);
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Linea: destino por sentido
// ---------------------------------------------------------------------------

describe("lineaToFeature: destino por sentido", () => {
  it("expone sentido y destino cuando se aportan", () => {
    const feature = lineaToFeature({
      linea: { codLinea: 7, nombre: "Línea 7" },
      sentido: 1,
      destino: "San Andrés",
    });
    expect(feature.properties.sentido).toBe(1);
    expect(feature.properties.destino).toBe("San Andrés");
  });

  it("omite destino cuando no se aporta", () => {
    const feature = lineaToFeature({ linea: { codLinea: 13 } });
    expect(feature.properties).not.toHaveProperty("destino");
    expect(feature.properties).not.toHaveProperty("sentido");
  });
});
