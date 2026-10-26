/**
 * Selección de la captura más reciente por vehículo (lógica pura).
 *
 * Dentro de la ventana de retención conviven varias capturas (`PosicionCaptura`)
 * por `codBus`. Para exponer la posición de un bus el sistema debe quedarse con
 * una sola captura por vehículo: la de `last_update` máximo. Este módulo
 * concentra esa selección como lógica pura, sin I/O, de modo que pueda
 * verificarse con `fast-check` (Property 6 / Requisito 2.5).
 *
 * Decisiones de contrato:
 *
 * - **Forma de salida.** La función base {@link latestByBus} devuelve la
 *   `PosicionCaptura` más reciente por `codBus` (conserva `codParIni`, útil para
 *   el estimador). {@link toBus} proyecta una captura al tipo de salida `Bus`, y
 *   {@link latestBusPositions} combina ambas para obtener directamente los `Bus`
 *   más recientes cuando no hace falta el detalle de la captura cruda.
 *
 * - **Comparación cronológica.** `last_update` es una marca de tiempo ISO en
 *   texto. Se compara parseándola a milisegundos de época con `Date.parse`, no
 *   lexicográficamente: aunque ISO-8601 en UTC con el mismo formato ordena bien
 *   como texto, variaciones de zona horaria u offset romperían la comparación
 *   léxica. Parsear a un valor numérico es seguro frente a esas variantes.
 *
 * - **Desempate determinista.** Si dos capturas del mismo `codBus` empatan en
 *   `last_update` (mismo instante tras parsear), gana la de `captured_at` más
 *   reciente (ingerida después). Si también empatan en `captured_at`, gana la
 *   que aparece más tarde en el orden de iteración de la entrada. El resultado
 *   es, por tanto, determinista para una entrada dada.
 *
 * - **Marcas inválidas.** Una `last_update` que `Date.parse` no sabe interpretar
 *   produce `NaN`; se trata como la menos reciente posible, de forma que nunca
 *   desplaza a una captura con marca válida. El orden de ingesta/normalización
 *   previo (`lib/normalize.ts`) es quien descarta filas malformadas; aquí solo
 *   se degrada con elegancia si llegara una marca no parseable.
 */

import type { Bus, CodBus, PosicionCaptura } from "@/lib/types";

/**
 * Convierte una marca de tiempo ISO a milisegundos de época comparables.
 * Una marca no parseable devuelve `-Infinity` para que ordene como la menos
 * reciente posible y nunca desplace a una captura con marca válida.
 */
function toEpochMs(isoTimestamp: string): number {
  const ms = Date.parse(isoTimestamp);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Indica si la captura `candidate` debe reemplazar a la `current` ya elegida
 * para un mismo `codBus`, aplicando el orden cronológico por `last_update` y el
 * desempate determinista documentado en la cabecera del módulo.
 *
 * Se asume que `candidate` aparece en la iteración después de `current`, lo que
 * resuelve el último criterio de desempate (orden de entrada) devolviendo `true`
 * ante igualdad total.
 */
function isMoreRecent(
  candidate: PosicionCaptura,
  current: PosicionCaptura,
): boolean {
  const candidateUpdate = toEpochMs(candidate.last_update);
  const currentUpdate = toEpochMs(current.last_update);

  if (candidateUpdate !== currentUpdate) {
    return candidateUpdate > currentUpdate;
  }

  // Empate en last_update: desempata captured_at (más reciente gana).
  const candidateCaptured = toEpochMs(candidate.captured_at);
  const currentCaptured = toEpochMs(current.captured_at);

  if (candidateCaptured !== currentCaptured) {
    return candidateCaptured > currentCaptured;
  }

  // Empate total: gana el que aparece más tarde en el orden de entrada.
  return true;
}

/**
 * Reduce un conjunto de capturas a la más reciente por `codBus`.
 *
 * Para cada `codBus` presente en la entrada devuelve exactamente una
 * `PosicionCaptura`: la de `last_update` máximo (con el desempate documentado).
 * El resultado contiene una entrada por `codBus` distinto; no se garantiza
 * ningún orden particular entre buses.
 *
 * @param capturas Conjunto de capturas crudas (varias por `codBus`).
 * @returns `Map` de `codBus` a su captura más reciente.
 */
export function latestByBus(
  capturas: Iterable<PosicionCaptura>,
): Map<CodBus, PosicionCaptura> {
  const latest = new Map<CodBus, PosicionCaptura>();

  for (const captura of capturas) {
    const current = latest.get(captura.codBus);
    if (current === undefined || isMoreRecent(captura, current)) {
      latest.set(captura.codBus, captura);
    }
  }

  return latest;
}

/**
 * Proyecta una captura cruda al tipo de salida `Bus`, descartando los campos
 * que no forman parte de la posición resuelta a exponer (p. ej. `codParIni`).
 */
export function toBus(captura: PosicionCaptura): Bus {
  return {
    codBus: captura.codBus,
    codLinea: captura.codLinea,
    sentido: captura.sentido,
    lon: captura.lon,
    lat: captura.lat,
    last_update: captura.last_update,
    captured_at: captura.captured_at,
  };
}

/**
 * Obtiene la posición más reciente de cada vehículo ya como `Bus`.
 *
 * Combina {@link latestByBus} y {@link toBus}: una entrada por `codBus`, la de
 * `last_update` máximo, proyectada al tipo de salida. El orden del array no está
 * garantizado.
 *
 * @param capturas Conjunto de capturas crudas (varias por `codBus`).
 * @returns Array de `Bus`, uno por `codBus` distinto.
 */
export function latestBusPositions(
  capturas: Iterable<PosicionCaptura>,
): Bus[] {
  const result: Bus[] = [];
  for (const captura of latestByBus(capturas).values()) {
    result.push(toBus(captura));
  }
  return result;
}
