/**
 * Property test de la paginación por cursor (tarea 6.3, `lib/pagination.ts`).
 *
 * - Property 32: la paginación particiona el conjunto completo.
 *   Validates: Requirement 11.3.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  paginar,
  recorrerPaginas,
  concatenarPaginas,
  MAX_PAGE_SIZE,
} from "@/lib/pagination";

describe("paginación por cursor — Property 32", () => {
  it("recorrer las páginas reconstruye el conjunto sin duplicados ni omisiones", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { minLength: 0, maxLength: 1000 }),
        fc.integer({ min: 1, max: 250 }),
        (conjunto, tamano) => {
          const paginas = recorrerPaginas(conjunto, tamano);
          const reensamblado = concatenarPaginas(paginas);
          // Partición exacta: misma longitud y mismo orden.
          expect(reensamblado).toEqual(conjunto);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("cada página tiene como máximo 200 elementos (Requisito 11.3)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { minLength: 0, maxLength: 1000 }),
        fc.integer({ min: 1, max: 500 }),
        (conjunto, tamano) => {
          const paginas = recorrerPaginas(conjunto, tamano);
          for (const pagina of paginas) {
            expect(pagina.items.length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("la última página (y solo ella) tiene cursor next nulo", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { minLength: 1, maxLength: 500 }),
        fc.integer({ min: 1, max: 100 }),
        (conjunto, tamano) => {
          const paginas = recorrerPaginas(conjunto, tamano);
          for (let i = 0; i < paginas.length; i += 1) {
            const esUltima = i === paginas.length - 1;
            if (esUltima) {
              expect(paginas[i].next).toBeNull();
            } else {
              expect(paginas[i].next).not.toBeNull();
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("un offset fuera de rango produce una página vacía con next nulo", () => {
    const pagina = paginar([1, 2, 3], 100, 10);
    expect(pagina.items).toEqual([]);
    expect(pagina.next).toBeNull();
  });
});
