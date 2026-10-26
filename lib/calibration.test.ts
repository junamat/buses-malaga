/**
 * Property test y tests de ejemplo del parser de minutos oficiales (tarea 8.3,
 * `lib/calibration.ts`).
 *
 * - Property 15: los valores oficiales fuera de rango se descartan y registran.
 *   Validates: Requirement 5.2.
 * - Test de ejemplo del parser sobre HTML de muestra incluyendo el centinela 785.
 *   Validates: Requirement 5.1.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  parsearMinutosOficiales,
  esMinutoValido,
  MIN_MINUTOS_OFICIALES,
  MAX_MINUTOS_OFICIALES,
  CENTINELA_SIN_ESTIMACION,
} from "@/lib/calibration";

/** Construye un `<span class="minutosN">` con el valor dado. */
function span(n: number, valor: number | string): string {
  return `<span class="minutos${n}">${valor} min.</span>`;
}

describe("parsearMinutosOficiales — Property 15", () => {
  it("clasifica cada valor: dentro de [0,120] válido, fuera descartado", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -50, max: 900 }), {
          minLength: 0,
          maxLength: 30,
        }),
        (valores) => {
          const html = valores.map((v, i) => span(i + 1, v)).join("\n");
          const { validos, descartados } = parsearMinutosOficiales(html);

          // Cada valor cae en exactamente una de las dos listas.
          expect(validos.length + descartados.length).toBe(valores.length);

          // Los válidos están todos en rango.
          for (const v of validos) {
            expect(v.minutos).toBeGreaterThanOrEqual(MIN_MINUTOS_OFICIALES);
            expect(v.minutos).toBeLessThanOrEqual(MAX_MINUTOS_OFICIALES);
          }

          // Los descartados por rango están fuera de [0,120] (Property 15).
          for (const d of descartados) {
            if (d.motivo === "fuera_de_rango") {
              expect(esMinutoValido(d.valor as number)).toBe(false);
            }
          }

          // Clasificación consistente con la referencia.
          const esperadosValidos = valores.filter((v) => esMinutoValido(v)).length;
          expect(validos.length).toBe(esperadosValidos);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("el centinela 785 se descarta como fuera de rango", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 120 }), (valido) => {
        const html = [span(1, valido), span(2, CENTINELA_SIN_ESTIMACION)].join("");
        const { validos, descartados } = parsearMinutosOficiales(html);
        expect(validos).toHaveLength(1);
        expect(validos[0].minutos).toBe(valido);
        expect(descartados).toHaveLength(1);
        expect(descartados[0].valor).toBe(CENTINELA_SIN_ESTIMACION);
        expect(descartados[0].motivo).toBe("fuera_de_rango");
      }),
    );
  });
});

describe("parsearMinutosOficiales — ejemplo (Requisito 5.1)", () => {
  it("extrae los minutos de un HTML de muestra con el centinela 785", () => {
    const html = `
      <ul class="lineas">
        <li class="linea">
          <span class="numeroLinea">3</span>
          <span class="destino">San Andrés</span>
          <span class="minutos1">5 min.</span>
        </li>
        <li class="linea">
          <span class="numeroLinea">11</span>
          <span class="destino">El Palo</span>
          <span class="minutos2">12 min.</span>
        </li>
        <li class="linea">
          <span class="numeroLinea">21</span>
          <span class="destino">Churriana</span>
          <span class="minutos3">785 min.</span>
        </li>
      </ul>`;

    const { validos, descartados } = parsearMinutosOficiales(html);

    expect(validos.map((v) => v.minutos)).toEqual([5, 12]);
    expect(descartados).toHaveLength(1);
    expect(descartados[0].valor).toBe(785);
    expect(descartados[0].motivo).toBe("fuera_de_rango");
  });

  it("tolera comillas simples y clases adicionales en el atributo class", () => {
    const html =
      "<span class='dato minutos1'>8 min.</span>" +
      '<span class="otro">ruido</span>' +
      '<span class="minutos2">0 min.</span>';
    const { validos } = parsearMinutosOficiales(html);
    expect(validos.map((v) => v.minutos)).toEqual([8, 0]);
  });
});
