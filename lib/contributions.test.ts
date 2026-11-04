/**
 * Property tests de aportaciones (tarea 13.4, `lib/contributions.ts`).
 *
 * - Property 26: una aportación válida queda persistida y asociada.
 * - Property 27: solo se muestran las aportaciones vigentes.
 * - Property 28: codBus desconocido rechaza la aportación con motivo.
 * - Property 29: una opción fuera del catálogo rechaza sin persistir.
 *   Validates: Requirements 9.1, 9.3, 9.4, 9.5, 9.6.
 *
 * Más ejemplos: catálogo de ≤ 10 opciones (9.2) y vigencia alrededor de 60 min.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  OPCIONES_APORTACION,
  VIGENCIA_APORTACION_MS,
  consultarAportaciones,
  esVigente,
  filtrarVigentes,
  registrarAportacion,
} from "@/lib/contributions";
import type { NuevaAportacion, Repository } from "@/lib/ports";
import type { Aportacion, CodBus } from "@/lib/types";

/** Repositorio en memoria con las operaciones de aportaciones. */
function repoEnMemoria(busesConocidos: CodBus[], previas: Aportacion[] = []) {
  const guardadas = [...previas];
  let n = 0;
  const repo: Pick<Repository, "existeBus" | "createAportacion" | "listAportacionesVigentes"> = {
    async existeBus(codBus) {
      return busesConocidos.includes(codBus);
    },
    async createAportacion(a: NuevaAportacion) {
      const creada: Aportacion = { id: `a-${++n}`, created_at: new Date().toISOString(), ...a };
      guardadas.push(creada);
      return creada;
    },
    async listAportacionesVigentes(codBus) {
      return guardadas.filter((a) => a.codBus === codBus);
    },
  };
  return { repo, guardadas };
}

const arbOpcion = fc.constantFrom(...OPCIONES_APORTACION.map((o) => o.id));
const arbOpcionAjena = fc
  .oneof(fc.string(), fc.integer(), fc.constant(null), fc.boolean())
  .filter((x) => !OPCIONES_APORTACION.some((o) => o.id === x));
const arbCodBus = fc.integer({ min: 1, max: 99999 });
const arbUser = fc.uuid();

describe("aportaciones — properties", () => {
  it("Property 26: una aportación válida queda persistida y asociada a codBus y usuario", async () => {
    await fc.assert(
      fc.asyncProperty(arbCodBus, arbUser, arbOpcion, async (codBus, userId, opcion) => {
        const { repo, guardadas } = repoEnMemoria([codBus]);
        const r = await registrarAportacion(repo, userId, codBus, opcion);
        expect(r.ok).toBe(true);
        expect(guardadas).toHaveLength(1);
        expect(guardadas[0]).toMatchObject({ codBus, userId, opcion });
        const visibles = await consultarAportaciones(repo, codBus);
        expect(visibles.map((a) => a.id)).toContain(guardadas[0].id);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 27: la consulta incluye las vigentes y excluye las expiradas", () => {
    const ahora = new Date("2026-11-04T12:00:00Z");
    fc.assert(
      fc.property(
        arbCodBus,
        fc.array(
          fc.record({
            codBus: fc.integer({ min: 1, max: 5 }),
            edadMs: fc.integer({ min: 0, max: 3 * VIGENCIA_APORTACION_MS }),
            opcion: arbOpcion,
          }),
          { maxLength: 50 },
        ),
        (codBusRaw, specs) => {
          const codBus = (codBusRaw % 5) + 1;
          const aportaciones: Aportacion[] = specs.map((s, i) => ({
            id: `a-${i}`,
            userId: "u",
            codBus: s.codBus,
            opcion: s.opcion,
            created_at: new Date(ahora.getTime() - s.edadMs).toISOString(),
          }));
          const r = filtrarVigentes(aportaciones, codBus, ahora);
          const esperadas = specs
            .map((s, i) => ({ s, id: `a-${i}` }))
            .filter(({ s }) => s.codBus === codBus && s.edadMs < VIGENCIA_APORTACION_MS)
            .map(({ id }) => id);
          expect(r.map((a) => a.id)).toEqual(esperadas);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Property 28: un codBus desconocido se rechaza con motivo y no se persiste", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(arbCodBus, { maxLength: 10 }),
        arbCodBus,
        arbUser,
        arbOpcion,
        async (conocidos, codBus, userId, opcion) => {
          fc.pre(!conocidos.includes(codBus));
          const { repo, guardadas } = repoEnMemoria(conocidos);
          const r = await registrarAportacion(repo, userId, codBus, opcion);
          expect(r).toEqual({ ok: false, motivo: "bus_desconocido" });
          expect(guardadas).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 29: una opción fuera del catálogo se rechaza sin tocar las previas", async () => {
    await fc.assert(
      fc.asyncProperty(arbCodBus, arbUser, arbOpcionAjena, async (codBus, userId, opcion) => {
        const previa: Aportacion = {
          id: "previa",
          userId: "otro",
          codBus,
          opcion: "lleno",
          created_at: new Date().toISOString(),
        };
        const { repo, guardadas } = repoEnMemoria([codBus], [previa]);
        const r = await registrarAportacion(repo, userId, codBus, opcion);
        expect(r).toEqual({ ok: false, motivo: "opcion_invalida" });
        expect(guardadas).toEqual([previa]);
      }),
      { numRuns: 100 },
    );
  });
});

describe("aportaciones — ejemplos", () => {
  it("el catálogo tiene entre 1 y 10 opciones con id único (9.2)", () => {
    expect(OPCIONES_APORTACION.length).toBeGreaterThan(0);
    expect(OPCIONES_APORTACION.length).toBeLessThanOrEqual(10);
    expect(new Set(OPCIONES_APORTACION.map((o) => o.id)).size).toBe(OPCIONES_APORTACION.length);
  });

  it("vigencia alrededor de 60 min: 59:59 vigente, 60:00 expirada (9.6)", () => {
    const ahora = new Date("2026-11-04T12:00:00Z");
    const con = (ms: number): Aportacion => ({
      id: "a",
      userId: "u",
      codBus: 1,
      opcion: "lleno",
      created_at: new Date(ahora.getTime() - ms).toISOString(),
    });
    expect(esVigente(con(VIGENCIA_APORTACION_MS - 1000), ahora)).toBe(true);
    expect(esVigente(con(VIGENCIA_APORTACION_MS), ahora)).toBe(false);
    expect(esVigente(con(0), ahora)).toBe(true);
  });
});
