/**
 * Property tests del Estimador_ETA (tarea 9.3, lógica pura de `lib/eta.ts`).
 *
 * Verifica con `fast-check` (≥ 100 iteraciones) las propiedades de corrección
 * del estimador:
 *
 * - Property 11: selección del ETA mínimo con cota de 60 minutos.
 * - Property 12: el ETA es no negativo y monótono en la distancia.
 * - Property 13: el ETA se expresa en minutos enteros.
 * - Property 14: posición obsoleta implica ETA no disponible.
 * - Property 16: el ETA de producción no contiene minutos oficiales.
 *   Validates: Requirements 4.1, 4.2, 4.4, 4.6, 5.4.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  distanciaATiempoMinutos,
  aMinutosEnteros,
  etaBusMinutos,
  seleccionarEtaLinea,
  calcularEtasPorLinea,
  COTA_ETA_MINUTOS,
  UMBRAL_OBSOLETO_SEGUNDOS,
  MARGEN_ETA_MINUTOS,
  type ObservacionBus,
} from "@/lib/eta";

/** Generador de una observación de bus "fresca" (no obsoleta) con velocidad > 0. */
const obsFresca = (codLinea: number, sentido: number) =>
  fc.record({
    codLinea: fc.constant(codLinea),
    sentido: fc.constant(sentido),
    distanciaMetros: fc.double({ min: 0, max: 50_000, noNaN: true }),
    velocidadMetrosSegundo: fc.double({
      min: 0.5,
      max: 25,
      noNaN: true,
      noDefaultInfinity: true,
    }),
    antiguedadSegundos: fc.double({
      min: 0,
      max: UMBRAL_OBSOLETO_SEGUNDOS,
      noNaN: true,
    }),
  });

describe("distanciaATiempoMinutos / aMinutosEnteros", () => {
  it("Property 12: el ETA es no negativo y monótono no decreciente en la distancia", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 50_000, noNaN: true }),
        fc.double({ min: 0, max: 50_000, noNaN: true }),
        fc.double({ min: 0.1, max: 30, noNaN: true, noDefaultInfinity: true }),
        (d1, d2, velocidad) => {
          const t1 = distanciaATiempoMinutos(d1, velocidad);
          const t2 = distanciaATiempoMinutos(d2, velocidad);
          expect(t1).not.toBeNull();
          expect(t2).not.toBeNull();
          // No negativo.
          expect(t1 as number).toBeGreaterThanOrEqual(0);
          expect(t2 as number).toBeGreaterThanOrEqual(0);
          // Monótono: a velocidad fija, mayor distancia ⇒ ETA no menor.
          if (d1 <= d2) {
            expect(t1 as number).toBeLessThanOrEqual(t2 as number);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("distancia 0 da ETA 0 (el bus está en la parada)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 30, noNaN: true, noDefaultInfinity: true }),
        (velocidad) => {
          expect(distanciaATiempoMinutos(0, velocidad)).toBe(0);
        },
      ),
    );
  });

  it("velocidad no positiva o no finita no es estimable (null)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 50_000, noNaN: true }),
        fc.double({ min: -30, max: 0, noNaN: true }),
        (distancia, velocidad) => {
          expect(distanciaATiempoMinutos(distancia, velocidad)).toBeNull();
        },
      ),
    );
  });

  it("Property 13: el ETA se expresa en minutos enteros no negativos", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 5_000, noNaN: true }),
        (minutosReales) => {
          const enteros = aMinutosEnteros(minutosReales);
          expect(enteros).not.toBeNull();
          expect(Number.isInteger(enteros as number)).toBe(true);
          expect(enteros as number).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("etaBusMinutos — Property 14 (obsolescencia)", () => {
  it("una posición con antigüedad > 120 s no produce ETA (null)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 50_000, noNaN: true }),
        fc.double({ min: 0.5, max: 25, noNaN: true, noDefaultInfinity: true }),
        fc.double({
          min: UMBRAL_OBSOLETO_SEGUNDOS + 0.001,
          max: 10_000,
          noNaN: true,
        }),
        (distancia, velocidad, antiguedad) => {
          const bus: ObservacionBus = {
            codLinea: 1,
            sentido: 1,
            distanciaMetros: distancia,
            velocidadMetrosSegundo: velocidad,
            antiguedadSegundos: antiguedad,
          };
          expect(etaBusMinutos(bus)).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("una posición fresca con velocidad > 0 produce un ETA entero", () => {
    fc.assert(
      fc.property(obsFresca(1, 1), (bus) => {
        const eta = etaBusMinutos(bus);
        expect(eta).not.toBeNull();
        expect(Number.isInteger(eta as number)).toBe(true);
        expect(eta as number).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });
});

describe("seleccionarEtaLinea — Property 11 (mínimo con cota 60 min)", () => {
  it("devuelve el mínimo de los ETA de buses dentro de la cota de 60 min", () => {
    fc.assert(
      fc.property(
        fc.array(obsFresca(7, 1), { minLength: 1, maxLength: 12 }),
        (buses) => {
          const eta = seleccionarEtaLinea(7, 1, buses);

          // ETA de referencia calculado aparte: mínimo de los estimables ≤ 60.
          const candidatos = buses
            .map((b) => etaBusMinutos(b))
            .filter((v): v is number => v !== null && v <= COTA_ETA_MINUTOS);

          if (candidatos.length === 0) {
            expect(eta.disponible).toBe(false);
            expect(eta.minutos).toBeNull();
          } else {
            expect(eta.disponible).toBe(true);
            expect(eta.minutos).toBe(Math.min(...candidatos));
            expect(eta.minutos as number).toBeLessThanOrEqual(COTA_ETA_MINUTOS);
            expect(eta.margenMinutos).toBe(MARGEN_ETA_MINUTOS);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("un conjunto vacío de buses no tiene ETA disponible", () => {
    const eta = seleccionarEtaLinea(7, 1, []);
    expect(eta.disponible).toBe(false);
    expect(eta.minutos).toBeNull();
    expect(eta.motivo).toBeTypeOf("string");
  });

  it("ignora buses con ETA por encima de la cota de 60 min", () => {
    // Bus muy lejano y lento ⇒ ETA > 60 min; debe quedar fuera.
    const lejano: ObservacionBus = {
      codLinea: 7,
      sentido: 1,
      distanciaMetros: 100_000,
      velocidadMetrosSegundo: 1,
      antiguedadSegundos: 0,
    };
    const eta = seleccionarEtaLinea(7, 1, [lejano]);
    expect(eta.disponible).toBe(false);
  });
});

describe("calcularEtasPorLinea — Property 16 (sin minutos oficiales)", () => {
  it("agrupa por (codLinea, sentido) y expone solo el contrato Eta", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            codLinea: fc.integer({ min: 1, max: 5 }),
            sentido: fc.integer({ min: 1, max: 2 }),
            distanciaMetros: fc.double({ min: 0, max: 20_000, noNaN: true }),
            velocidadMetrosSegundo: fc.double({
              min: 0.5,
              max: 25,
              noNaN: true,
              noDefaultInfinity: true,
            }),
            antiguedadSegundos: fc.double({ min: 0, max: 100, noNaN: true }),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        (observaciones) => {
          const etas = calcularEtasPorLinea(observaciones);
          // Una entrada por par (codLinea, sentido) distinto presente.
          const pares = new Set(
            observaciones.map((o) => `${o.codLinea}|${o.sentido}`),
          );
          expect(etas.length).toBe(pares.size);

          for (const eta of etas) {
            // El objeto Eta no contiene ninguna clave de minutos oficiales
            // (Property 16): sus claves son exactamente las del contrato.
            const claves = Object.keys(eta).sort();
            for (const clave of claves) {
              expect(
                ["codLinea", "sentido", "minutos", "disponible", "margenMinutos", "motivo"],
              ).toContain(clave);
            }
            expect(eta).not.toHaveProperty("official_minutes");
            expect(eta).not.toHaveProperty("minutosOficiales");
          }

          // Orden determinista por codLinea, luego sentido.
          for (let i = 1; i < etas.length; i += 1) {
            const prev = etas[i - 1];
            const cur = etas[i];
            const antes =
              prev.codLinea < cur.codLinea ||
              (prev.codLinea === cur.codLinea && prev.sentido <= cur.sentido);
            expect(antes).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
