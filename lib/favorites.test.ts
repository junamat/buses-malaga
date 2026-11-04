/**
 * Property tests de favoritos (tarea 13.3, `lib/favorites.ts`).
 *
 * - Property 20: marcar un favorito existente lo añade al conjunto del usuario.
 * - Property 21: referenciar un elemento inexistente rechaza y preserva el conjunto.
 * - Property 22: la consulta de favoritos recupera el conjunto del usuario.
 * - Property 23: añadir y luego eliminar un favorito preserva el resto.
 * - Property 24: eliminar un favorito inexistente rechaza sin cambios.
 * - Property 25: marcar un favorito es idempotente.
 *   Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.7, 8.8, 8.9.
 *
 * Más ejemplos de borde: usuario sin favoritos (8.6), límite de 500 (8.10) y
 * validación del cuerpo (11.8, 11.9).
 */

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";

import {
  LIMITE_FAVORITOS,
  altaFavorito,
  bajaFavorito,
  consultarFavoritos,
  crearFavorito,
  mismoElemento,
  validarReferencia,
  type ReferenciaFavorito,
} from "@/lib/favorites";
import type { Favorito } from "@/lib/types";

const USER = "u-1";

const arbReferencia: fc.Arbitrary<ReferenciaFavorito> = fc.oneof(
  fc.record({ tipo: fc.constant("parada" as const), codParada: fc.stringMatching(/^[0-9]{1,4}$/) }),
  fc.record({ tipo: fc.constant("linea" as const), codLinea: fc.integer({ min: 1, max: 200 }) }),
  fc.record({
    tipo: fc.constant("parada_linea" as const),
    codParada: fc.stringMatching(/^[0-9]{1,4}$/),
    codLinea: fc.integer({ min: 1, max: 200 }),
  }),
);

function clave(r: ReferenciaFavorito): string {
  return `${r.tipo}|${r.codParada ?? ""}|${r.codLinea ?? ""}`;
}

/** Conjunto de favoritos de un usuario, sin elementos repetidos. */
const arbConjunto = (maxLength = 40): fc.Arbitrary<Favorito[]> =>
  fc
    .uniqueArray(arbReferencia, { selector: clave, maxLength })
    .map((refs) => refs.map((r, i) => ({ id: `f-${i}`, userId: USER, ...r })));

let contador = 0;
const nuevoId = (): string => `nuevo-${++contador}`;

describe("favoritos — properties", () => {
  it("Property 20: marcar un elemento existente lo deja en el conjunto", () => {
    fc.assert(
      fc.property(arbConjunto(), arbReferencia, (conjunto, ref) => {
        const r = altaFavorito(conjunto, USER, ref, true, nuevoId);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.conjunto.some((f) => mismoElemento(f, ref) && f.userId === USER)).toBe(true);
        // El resto no cambia.
        for (const f of conjunto) expect(r.conjunto).toContainEqual(f);
      }),
      { numRuns: 200 },
    );
  });

  it("Property 21: un elemento inexistente se rechaza y el conjunto no cambia", () => {
    fc.assert(
      fc.property(arbConjunto(), arbReferencia, (conjunto, ref) => {
        const antes = structuredClone(conjunto);
        const r = altaFavorito(conjunto, USER, ref, false, nuevoId);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.motivo).toBe("elemento_inexistente");
        expect(r.conjunto).toEqual(antes);
        expect(conjunto).toEqual(antes);
      }),
      { numRuns: 200 },
    );
  });

  it("Property 22: la consulta devuelve exactamente el conjunto del usuario", () => {
    fc.assert(
      fc.property(
        fc.tuple(arbConjunto(), arbConjunto()).chain(([propios, ajenos]) => {
          const otros = ajenos.map((f) => ({ ...f, id: `o-${f.id}`, userId: "u-2" }));
          const todos = [...propios, ...otros];
          return fc.tuple(
            fc.constant(propios),
            fc.shuffledSubarray(todos, { minLength: todos.length }),
          );
        }),
        ([propios, mezclados]) => {
        const r = consultarFavoritos(mezclados, USER);
        expect(new Set(r.map((f) => f.id))).toEqual(new Set(propios.map((f) => f.id)));
        expect(r.every((f) => f.userId === USER)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 23: añadir y luego eliminar un favorito preserva el resto", () => {
    fc.assert(
      fc.property(arbConjunto(), arbReferencia, (conjunto, ref) => {
        fc.pre(!conjunto.some((f) => mismoElemento(f, ref)));
        const alta = altaFavorito(conjunto, USER, ref, true, nuevoId);
        expect(alta.ok).toBe(true);
        if (!alta.ok) return;
        const baja = bajaFavorito(alta.conjunto, alta.favorito.id);
        expect(baja.ok).toBe(true);
        if (!baja.ok) return;
        expect(baja.conjunto).toEqual(conjunto);
      }),
      { numRuns: 200 },
    );
  });

  it("Property 23: eliminar un favorito existente lo quita y conserva los demás", () => {
    fc.assert(
      fc.property(
        arbConjunto().filter((c) => c.length > 0),
        fc.nat(),
        (conjunto, i) => {
          const objetivo = conjunto[i % conjunto.length];
          const r = bajaFavorito(conjunto, objetivo.id);
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect(r.conjunto.some((f) => f.id === objetivo.id)).toBe(false);
          expect(r.conjunto).toEqual(conjunto.filter((f) => f.id !== objetivo.id));
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Property 24: eliminar un favorito que no figura se rechaza sin cambios", () => {
    fc.assert(
      fc.property(arbConjunto(), fc.uuid(), (conjunto, id) => {
        const antes = structuredClone(conjunto);
        const r = bajaFavorito(conjunto, id);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.motivo).toBe("favorito_inexistente");
        expect(r.conjunto).toEqual(antes);
      }),
      { numRuns: 200 },
    );
  });

  it("Property 25: marcar un favorito una o más veces deja un único registro", () => {
    fc.assert(
      fc.property(arbConjunto(), arbReferencia, fc.integer({ min: 1, max: 5 }), (conjunto, ref, veces) => {
        let actual = conjunto;
        for (let i = 0; i < veces; i++) {
          const r = altaFavorito(actual, USER, ref, true, nuevoId);
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect(r.creado).toBe(i === 0 && !conjunto.some((f) => mismoElemento(f, ref)));
          actual = r.conjunto;
        }
        expect(actual.filter((f) => mismoElemento(f, ref))).toHaveLength(1);
      }),
      { numRuns: 200 },
    );
  });
});

describe("favoritos — ejemplos de borde", () => {
  const lleno: Favorito[] = Array.from({ length: LIMITE_FAVORITOS }, (_, i) => ({
    id: `f-${i}`,
    userId: USER,
    tipo: "linea",
    codLinea: i + 1,
  }));

  it("un usuario sin favoritos obtiene un conjunto vacío (8.6)", () => {
    expect(consultarFavoritos([], USER)).toEqual([]);
  });

  it("con 500 favoritos se rechaza uno nuevo sin persistirlo (8.10)", () => {
    const r = altaFavorito(lleno, USER, { tipo: "parada", codParada: "1" }, true, nuevoId);
    expect(r).toMatchObject({ ok: false, motivo: "limite_alcanzado" });
    expect(r.conjunto).toHaveLength(LIMITE_FAVORITOS);
  });

  it("con 499 favoritos aún se admite uno más", () => {
    const r = altaFavorito(lleno.slice(1), USER, { tipo: "parada", codParada: "1" }, true, nuevoId);
    expect(r.ok).toBe(true);
    expect(r.conjunto).toHaveLength(LIMITE_FAVORITOS);
  });

  it("en el límite, repetir un favorito existente no es error (idempotencia antes que límite)", () => {
    const r = altaFavorito(lleno, USER, { tipo: "linea", codLinea: 1 }, true, nuevoId);
    expect(r).toMatchObject({ ok: true, creado: false });
  });

  it("crearFavorito no persiste si el elemento no existe", async () => {
    const repo = {
      findParada: vi.fn().mockResolvedValue(null),
      existeLinea: vi.fn().mockResolvedValue(true),
      listFavoritos: vi.fn().mockResolvedValue([]),
      createFavorito: vi.fn(),
    };
    const r = await crearFavorito(repo, USER, { tipo: "parada_linea", codParada: "9", codLinea: 1 });
    expect(r).toMatchObject({ ok: false, motivo: "elemento_inexistente" });
    expect(repo.createFavorito).not.toHaveBeenCalled();
  });

  it("crearFavorito no vuelve a insertar un favorito repetido", async () => {
    const existente: Favorito = { id: "f-1", userId: USER, tipo: "linea", codLinea: 3 };
    const repo = {
      findParada: vi.fn(),
      existeLinea: vi.fn().mockResolvedValue(true),
      listFavoritos: vi.fn().mockResolvedValue([existente]),
      createFavorito: vi.fn(),
    };
    const r = await crearFavorito(repo, USER, { tipo: "linea", codLinea: 3 });
    expect(r).toMatchObject({ ok: true, creado: false, favorito: existente });
    expect(repo.createFavorito).not.toHaveBeenCalled();
  });
});

describe("validarReferencia", () => {
  it("exige tipo y los códigos del tipo", () => {
    expect(validarReferencia({})).toEqual({ ok: false, ausentes: ["tipo"] });
    expect(validarReferencia({ tipo: "parada_linea" })).toEqual({
      ok: false,
      ausentes: ["codParada", "codLinea"],
    });
  });

  it("rechaza cuerpos y tipos malformados", () => {
    for (const malo of [null, [], "x", 3, { tipo: "barrio" }, { tipo: "linea", codLinea: "abc" }, { tipo: "linea", codLinea: true }]) {
      const r = validarReferencia(malo);
      expect(r.ok).toBe(false);
      expect("message" in r).toBe(true);
    }
  });

  it("descarta los códigos que no corresponden al tipo", () => {
    expect(validarReferencia({ tipo: "linea", codLinea: "7", codParada: "1" })).toEqual({
      ok: true,
      referencia: { tipo: "linea", codLinea: 7 },
    });
  });
});
