import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type {
  Bus,
  GeoJSONFeatureCollection,
  BusFeatureProperties,
  GeoJSONPoint,
} from "@/lib/types";

/**
 * Smoke test de la configuración base: verifica que Vitest y fast-check están
 * cableados y que los tipos internos compartidos son utilizables. No valida
 * lógica de dominio (todavía no existe); eso llega en tareas posteriores.
 */
describe("configuración base del proyecto", () => {
  it("ejecuta Vitest correctamente", () => {
    expect(1 + 1).toBe(2);
  });

  it("ejecuta fast-check con al menos 100 iteraciones", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
      { numRuns: 100 },
    );
  });

  it("los tipos internos compartidos son construibles", () => {
    const bus: Bus = {
      codBus: 101,
      codLinea: 3,
      sentido: 1,
      lon: -4.42,
      lat: 36.72,
      last_update: "2024-01-01T00:00:00Z",
      captured_at: "2024-01-01T00:00:05Z",
    };

    const fc_: GeoJSONFeatureCollection<BusFeatureProperties, GeoJSONPoint> = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [bus.lon, bus.lat] },
          properties: {
            codBus: bus.codBus,
            codLinea: bus.codLinea,
            sentido: bus.sentido,
            last_update: bus.last_update,
            captured_at: bus.captured_at,
            obsoleto: false,
          },
        },
      ],
    };

    expect(fc_.features[0].geometry.coordinates).toEqual([-4.42, 36.72]);
    expect(fc_.features[0].properties.codBus).toBe(101);
  });
});
