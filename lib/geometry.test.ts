/**
 * Property tests de geometría/distancia (tarea 6.3, `lib/geometry.ts`).
 *
 * - Property 17: paradas cercanas: radio, límite y orden.
 * - Property 18: la distancia mostrada coincide con la calculada.
 *   Validates: Requirements 6.2, 6.6.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  distanciaMetros,
  paradasCercanas,
  RADIO_PARADAS_CERCANAS_METROS,
  MAX_PARADAS_CERCANAS,
} from "@/lib/geometry";
import type { Parada, Position } from "@/lib/types";

/** Generador de coordenadas en el área de Málaga (para distancias realistas). */
const coordMalaga = (): fc.Arbitrary<Position> =>
  fc.tuple(
    fc.double({ min: -4.6, max: -4.2, noNaN: true }),
    fc.double({ min: 36.6, max: 36.85, noNaN: true }),
  );

const parada = (i: number): fc.Arbitrary<Parada> =>
  coordMalaga().map(([lon, lat]) => ({
    codParada: `P${String(i).padStart(4, "0")}`,
    nombre: `Parada ${i}`,
    lon,
    lat,
  }));

describe("distanciaMetros", () => {
  it("es no negativa, simétrica y cero cuando los puntos coinciden", () => {
    fc.assert(
      fc.property(coordMalaga(), coordMalaga(), (a, b) => {
        const dab = distanciaMetros(a, b);
        const dba = distanciaMetros(b, a);
        expect(dab).toBeGreaterThanOrEqual(0);
        // Simetría (con tolerancia de redondeo).
        expect(Math.abs(dab - dba)).toBeLessThan(1e-6);
        // Distancia de un punto a sí mismo = 0.
        expect(distanciaMetros(a, a)).toBeCloseTo(0, 6);
      }),
      { numRuns: 300 },
    );
  });
});

describe("paradasCercanas — Properties 17 y 18", () => {
  it("todas las devueltas están dentro del radio y son ≤ límite, orden ascendente", () => {
    fc.assert(
      fc.property(
        coordMalaga(),
        fc.array(fc.integer({ min: 0, max: 9999 }), { minLength: 0, maxLength: 60 }).chain(
          (ids) => fc.tuple(...ids.map((i) => parada(i))),
        ),
        (usuario, paradas) => {
          const cercanas = paradasCercanas(
            usuario,
            paradas,
            RADIO_PARADAS_CERCANAS_METROS,
            MAX_PARADAS_CERCANAS,
          );

          // Property 17a: límite.
          expect(cercanas.length).toBeLessThanOrEqual(MAX_PARADAS_CERCANAS);

          for (let i = 0; i < cercanas.length; i += 1) {
            // Property 17b: radio (borde incluido).
            expect(cercanas[i].distanciaMetros).toBeLessThanOrEqual(
              RADIO_PARADAS_CERCANAS_METROS,
            );
            // Property 18: la distancia mostrada coincide con la calculada.
            const esperada = distanciaMetros(usuario, [
              cercanas[i].lon,
              cercanas[i].lat,
            ]);
            expect(cercanas[i].distanciaMetros).toBeCloseTo(esperada, 6);
            // Property 17c: orden ascendente por distancia.
            if (i > 0) {
              expect(cercanas[i - 1].distanciaMetros).toBeLessThanOrEqual(
                cercanas[i].distanciaMetros,
              );
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("no omite ninguna parada dentro del radio cuando caben en el límite", () => {
    fc.assert(
      fc.property(
        coordMalaga(),
        fc.array(fc.integer({ min: 0, max: 9999 }), { minLength: 0, maxLength: 8 }).chain(
          (ids) => fc.tuple(...ids.map((i) => parada(i))),
        ),
        (usuario, paradas) => {
          const dentro = paradas.filter(
            (p) =>
              distanciaMetros(usuario, [p.lon, p.lat]) <=
              RADIO_PARADAS_CERCANAS_METROS,
          );
          const cercanas = paradasCercanas(
            usuario,
            paradas,
            RADIO_PARADAS_CERCANAS_METROS,
            MAX_PARADAS_CERCANAS,
          );
          // Con ≤ 8 paradas candidatas y límite 10, todas las que están dentro
          // del radio deben aparecer (sin omisiones).
          expect(cercanas.length).toBe(Math.min(dentro.length, MAX_PARADAS_CERCANAS));
        },
      ),
      { numRuns: 200 },
    );
  });
});
