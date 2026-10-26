/**
 * Filtrado de la visualización por Línea y Sentido (lógica pura, sin I/O).
 *
 * Este módulo implementa el Requisito 3: filtrar Buses y Paradas por un
 * conjunto de Líneas, filtrar Buses por Sentido, componer ambos criterios con
 * lógica AND (intersección), limpiar los filtros para restaurar el conjunto
 * base y señalar la combinación sin resultados conservando el estado de los
 * filtros.
 *
 * Decisiones de modelado relevantes:
 *
 * - El estado de filtros (`FilterState`) es un **value object inmutable**: el
 *   conjunto de Líneas seleccionadas y el Sentido seleccionado. Las funciones
 *   que lo modifican devuelven un estado nuevo y no mutan el recibido.
 * - `apply` es una **función pura** que recibe el estado de filtros y el
 *   **conjunto base** (previo a cualquier filtro) y devuelve el subconjunto
 *   filtrado junto con un indicador de "sin resultados". El conjunto base se
 *   conserva aparte, de modo que `clear` es un simple round-trip a él
 *   (Requisito 3.4) y el estado de filtros nunca se pierde al no haber
 *   resultados (Requisito 3.5).
 * - El filtro por **Línea** aplica tanto a Buses como a Paradas; el filtro por
 *   **Sentido** aplica solo a Buses (una `Parada` no tiene Sentido). Como una
 *   `Parada` tampoco expone `codLinea`, la asociación parada → líneas se
 *   resuelve mediante una función de consulta (`ParadaLineasLookup`) inyectada
 *   por el llamante; así el módulo permanece puro y sin dependencias de datos.
 * - La composición es **confluente**: el resultado es idéntico con
 *   independencia del orden en que se añadan los criterios, porque ambos son
 *   predicados de pertenencia a conjunto combinados con AND (Requisito 3.3).
 */

import type { Bus, Parada, Sentido, CodLinea } from "@/lib/types";

// ---------------------------------------------------------------------------
// Estado de filtros (value object inmutable)
// ---------------------------------------------------------------------------

/**
 * Estado de los filtros activos. Inmutable: las operaciones devuelven un estado
 * nuevo.
 *
 * - `lineas`: conjunto de Líneas seleccionadas. Vacío ⇒ sin filtro por Línea
 *   (no se oculta ningún elemento por este criterio).
 * - `sentido`: Sentido seleccionado, o `null` ⇒ sin filtro por Sentido.
 */
export interface FilterState {
  readonly lineas: ReadonlySet<CodLinea>;
  readonly sentido: Sentido | null;
}

/** Conjunto base (previo a cualquier filtro) de Buses y Paradas a filtrar. */
export interface BaseSet {
  readonly buses: readonly Bus[];
  readonly paradas: readonly Parada[];
}

/**
 * Resultado de aplicar los filtros a un conjunto base.
 *
 * - `buses`/`paradas`: subconjunto que satisface los filtros activos.
 * - `sinResultados`: `true` cuando la combinación de filtros activos no
 *   corresponde a ningún Bus ni Parada (Requisito 3.5). Es `false` cuando no
 *   hay filtros activos aunque el conjunto base esté vacío: "sin resultados"
 *   describe una combinación de filtros, no la ausencia de datos de origen.
 */
export interface FilterResult {
  readonly buses: readonly Bus[];
  readonly paradas: readonly Parada[];
  readonly sinResultados: boolean;
}

/**
 * Función de consulta que resuelve las Líneas que atienden a una Parada. El
 * llamante la provee a partir del modelo de datos (p. ej. `stop_times`),
 * manteniendo este módulo libre de I/O. Debe ser pura.
 */
export type ParadaLineasLookup = (parada: Parada) => Iterable<CodLinea>;

/** Estado de filtros vacío: ningún criterio activo. */
export const EMPTY_FILTER_STATE: FilterState = {
  lineas: new Set<CodLinea>(),
  sentido: null,
};

// ---------------------------------------------------------------------------
// Transiciones del estado de filtros (inmutables)
// ---------------------------------------------------------------------------

/**
 * Devuelve un estado nuevo con el conjunto de Líneas indicado como filtro por
 * Línea. Un conjunto vacío equivale a no filtrar por Línea. No muta el estado
 * recibido.
 */
export function withLineas(
  state: FilterState,
  lineas: Iterable<CodLinea>,
): FilterState {
  return { ...state, lineas: new Set(lineas) };
}

/**
 * Devuelve un estado nuevo con el Sentido indicado como filtro por Sentido.
 * `null` equivale a no filtrar por Sentido. No muta el estado recibido.
 */
export function withSentido(
  state: FilterState,
  sentido: Sentido | null,
): FilterState {
  return { ...state, sentido };
}

/**
 * Limpia todos los filtros devolviendo el estado vacío. Combinado con `apply`
 * sobre el mismo conjunto base, restaura exactamente la vista previa a cualquier
 * filtro (round-trip del Requisito 3.4).
 */
export function clear(): FilterState {
  return EMPTY_FILTER_STATE;
}

/** ¿Hay al menos un filtro activo (Línea o Sentido)? */
export function hasActiveFilters(state: FilterState): boolean {
  return state.lineas.size > 0 || state.sentido !== null;
}

// ---------------------------------------------------------------------------
// Predicados de filtrado
// ---------------------------------------------------------------------------

/**
 * ¿El Bus satisface el filtro por Línea? Un conjunto de Líneas vacío no filtra
 * (todos pasan).
 */
function busMatchesLinea(bus: Bus, lineas: ReadonlySet<CodLinea>): boolean {
  return lineas.size === 0 || lineas.has(bus.codLinea);
}

/**
 * ¿El Bus satisface el filtro por Sentido? `null` no filtra (todos pasan).
 */
function busMatchesSentido(bus: Bus, sentido: Sentido | null): boolean {
  return sentido === null || bus.sentido === sentido;
}

/**
 * ¿La Parada satisface el filtro por Línea? Un conjunto vacío no filtra. En
 * otro caso, la Parada pasa si alguna de sus Líneas (según `lookup`) está en el
 * conjunto seleccionado.
 */
function paradaMatchesLinea(
  parada: Parada,
  lineas: ReadonlySet<CodLinea>,
  lookup: ParadaLineasLookup,
): boolean {
  if (lineas.size === 0) {
    return true;
  }
  for (const codLinea of lookup(parada)) {
    if (lineas.has(codLinea)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Aplicación de los filtros
// ---------------------------------------------------------------------------

/**
 * Aplica el estado de filtros al conjunto base y devuelve el subconjunto
 * filtrado junto con el indicador de "sin resultados".
 *
 * Reglas (Requisito 3):
 * - Filtro por Línea (3.1): incluye solo Buses y Paradas cuyo `codLinea` (las
 *   Paradas vía `lookup`) esté en el conjunto seleccionado; oculta el resto.
 * - Filtro por Sentido (3.2): incluye solo Buses cuyo Sentido coincide; las
 *   Paradas no se ven afectadas por el Sentido.
 * - AND combinado (3.3): un Bus debe cumplir Línea **y** Sentido. El resultado
 *   es independiente del orden de aplicación (confluente).
 * - Sin resultados (3.5): `sinResultados` es `true` cuando hay filtros activos y
 *   el resultado es vacío. El estado de filtros se recibe por valor y no se
 *   modifica.
 *
 * La función es pura: no muta `state` ni `base`.
 *
 * @param state Estado de filtros activos.
 * @param base Conjunto base (previo a cualquier filtro).
 * @param paradaLineas Consulta parada → Líneas; obligatoria solo si hay filtro
 *   por Línea y Paradas en el conjunto base. Si se omite y hay filtro por Línea,
 *   ninguna Parada supera el filtro por Línea.
 */
export function apply(
  state: FilterState,
  base: BaseSet,
  paradaLineas: ParadaLineasLookup = () => [],
): FilterResult {
  const buses = base.buses.filter(
    (bus) =>
      busMatchesLinea(bus, state.lineas) &&
      busMatchesSentido(bus, state.sentido),
  );

  const paradas = base.paradas.filter((parada) =>
    paradaMatchesLinea(parada, state.lineas, paradaLineas),
  );

  const sinResultados =
    hasActiveFilters(state) && buses.length === 0 && paradas.length === 0;

  return { buses, paradas, sinResultados };
}
