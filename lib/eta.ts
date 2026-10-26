/**
 * Estimador de llegada (ETA) — lógica pura (tarea 9.1).
 *
 * El `Estimador_ETA` calcula, por línea y sentido, los minutos hasta que el
 * siguiente bus alcance una parada. La parte que vive aquí es **pura y sin I/O**:
 * recibe, para cada bus candidato, la distancia a lo largo del recorrido entre
 * el bus y la parada y la velocidad estimada del bus (ambas calculadas por el
 * map-matching PostGIS de la tarea 9.2, `ST_LineLocatePoint`/`ST_LineSubstring`
 * sobre el `shape`), y las convierte en un ETA. Así las reglas del estimador
 * pueden verificarse con `fast-check` con independencia de la base de datos.
 *
 * Reglas del contrato (Requisitos 4.1–4.7; Properties 11–14):
 *
 * - **No negativo y monótono** (Property 12): el ETA es ≥ 0 y no decrece al
 *   aumentar la distancia a recorrer (a velocidad fija). Una distancia 0 da
 *   ETA 0 (el bus está en la parada).
 * - **Minutos enteros** (Property 13): el ETA expuesto se redondea a minutos
 *   enteros no negativos (Requisito 4.4).
 * - **Posición obsoleta ⇒ no disponible** (Property 14): si la última posición
 *   del bus tiene una antigüedad mayor que {@link UMBRAL_OBSOLETO_SEGUNDOS}
 *   (120 s), ese bus no produce estimación (Requisito 4.6).
 * - **Selección del mínimo con cota de 60 min** (Property 11): para una línea se
 *   expone el ETA mínimo entre los buses con ETA ≤ {@link COTA_ETA_MINUTOS}
 *   (60 min); si ningún bus cumple la cota, no hay ETA disponible (Requisito
 *   4.1, 4.2).
 * - **Margen ±1 min** (Requisito 4.7): toda estimación disponible declara un
 *   margen de confianza de {@link MARGEN_ETA_MINUTOS} minutos; la señalización
 *   "mejor esfuerzo" la hace el cliente (tarea 10.4).
 *
 * Los minutos oficiales de calibración (`lib/calibration.ts`, `official_minutes`)
 * **no** intervienen aquí: el ETA de producción se calcula solo con posiciones y
 * geometría (Requisito 5.4, Property 16).
 *
 * Es lógica pura, sin I/O ni acceso al reloj del sistema: el instante de
 * referencia se inyecta.
 */

import type { Eta, CodLinea, Sentido } from "@/lib/types";

/** Segundos en un minuto, para convertir velocidad (m/s) a tiempo en minutos. */
const SEGUNDOS_POR_MINUTO = 60;

/**
 * Antigüedad máxima (en segundos) de la última posición de un bus para que
 * produzca estimación. Más allá de 120 s la posición se considera obsoleta y el
 * bus no aporta ETA (Requisito 4.6). Coincide con el umbral de obsolescencia del
 * GeoJSON (`DEFAULT_STALENESS_THRESHOLD_MS` = 120 000 ms en `lib/geojson.ts`).
 */
export const UMBRAL_OBSOLETO_SEGUNDOS = 120;

/**
 * Cota superior del ETA en minutos: solo se consideran buses cuya estimación no
 * supera los 60 min. Un bus con ETA mayor se ignora para la selección del mínimo
 * por línea (Requisito 4.2). La comparación se hace sobre minutos enteros.
 */
export const COTA_ETA_MINUTOS = 60;

/** Margen de confianza de la estimación, en minutos (±). (Requisito 4.7) */
export const MARGEN_ETA_MINUTOS = 1;

/** Motivos canónicos por los que una línea no tiene ETA disponible. */
export const MOTIVO_ETA = {
  sinBuses: "No hay buses de la línea con posición vigente hacia esta parada.",
  posicionObsoleta:
    "La posición más reciente del bus supera los 120 s de antigüedad.",
  fueraDeCota: "El bus más próximo supera la cota de 60 minutos de estimación.",
} as const;

/**
 * Observación de un bus candidato para el cálculo de ETA hacia una parada, tal
 * como la produce el map-matching PostGIS (tarea 9.2). Todas las magnitudes son
 * ya numéricas y en unidades del SI.
 */
export interface ObservacionBus {
  codLinea: CodLinea;
  sentido: Sentido;
  /**
   * Distancia a lo largo del recorrido entre el bus y la parada, en metros.
   * Se asume ≥ 0 (el map-matching no devuelve distancias negativas); un valor
   * negativo se trata como 0.
   */
  distanciaMetros: number;
  /**
   * Velocidad estimada del bus en metros por segundo, inferida de capturas
   * consecutivas. Una velocidad ≤ 0 (bus detenido o sin histórico suficiente)
   * no permite estimar tiempo de llegada.
   */
  velocidadMetrosSegundo: number;
  /**
   * Antigüedad de la última posición del bus respecto al instante de referencia,
   * en segundos. Si supera {@link UMBRAL_OBSOLETO_SEGUNDOS} el bus se descarta.
   */
  antiguedadSegundos: number;
}

/**
 * Convierte una distancia a lo largo del recorrido y una velocidad en un ETA en
 * minutos (valor real, aún sin redondear). El resultado es no negativo y
 * monótono no decreciente en la distancia a velocidad fija (Property 12).
 *
 * Devuelve `null` cuando no se puede estimar el tiempo: velocidad no positiva o
 * no finita, o distancia no finita. Una distancia negativa se trata como 0 (el
 * bus ya está en la parada o la rebasó: ETA 0).
 *
 * @param distanciaMetros Distancia a recorrer, en metros.
 * @param velocidadMetrosSegundo Velocidad del bus, en m/s.
 * @returns ETA en minutos (≥ 0) o `null` si no es estimable.
 */
export function distanciaATiempoMinutos(
  distanciaMetros: number,
  velocidadMetrosSegundo: number,
): number | null {
  if (
    !Number.isFinite(distanciaMetros) ||
    !Number.isFinite(velocidadMetrosSegundo) ||
    velocidadMetrosSegundo <= 0
  ) {
    return null;
  }
  const distancia = distanciaMetros > 0 ? distanciaMetros : 0;
  const segundos = distancia / velocidadMetrosSegundo;
  return segundos / SEGUNDOS_POR_MINUTO;
}

/**
 * Redondea un ETA en minutos (real) a minutos enteros no negativos, tal como se
 * expone (Requisito 4.4, Property 13). Un valor no finito o negativo se
 * considera no estimable (`null`).
 */
export function aMinutosEnteros(minutos: number | null): number | null {
  if (minutos === null || !Number.isFinite(minutos) || minutos < 0) {
    return null;
  }
  return Math.round(minutos);
}

/**
 * Calcula el ETA en minutos enteros de un único bus hacia la parada, aplicando
 * las reglas de obsolescencia, estimabilidad y redondeo. Devuelve `null` si el
 * bus no produce estimación (posición obsoleta o velocidad no positiva).
 *
 * No aplica la cota de 60 min: esa es una decisión de **selección** entre buses
 * de una línea, que vive en {@link seleccionarEtaLinea}.
 */
export function etaBusMinutos(bus: ObservacionBus): number | null {
  if (bus.antiguedadSegundos > UMBRAL_OBSOLETO_SEGUNDOS) {
    return null;
  }
  const minutosReales = distanciaATiempoMinutos(
    bus.distanciaMetros,
    bus.velocidadMetrosSegundo,
  );
  return aMinutosEnteros(minutosReales);
}

/**
 * Selecciona el ETA de una línea/sentido a partir de las observaciones de sus
 * buses: el **mínimo** de los ETA de los buses estimables cuyo ETA no supera la
 * cota de 60 min (Property 11, Requisitos 4.1, 4.2).
 *
 * El resultado es siempre un {@link Eta} coherente con el contrato HTTP del
 * endpoint (Requisito 11.6): cuando no hay estimación, `minutos` es `null`,
 * `disponible` es `false` y se indica el `motivo`; cuando la hay, declara el
 * margen de ±1 min.
 *
 * Requiere que todas las observaciones compartan `codLinea`/`sentido`; usa los
 * de la primera. Un conjunto vacío produce "sin buses".
 *
 * @param codLinea Línea a la que corresponde la estimación.
 * @param sentido Sentido al que corresponde la estimación.
 * @param buses Observaciones de los buses de esa línea/sentido hacia la parada.
 */
export function seleccionarEtaLinea(
  codLinea: CodLinea,
  sentido: Sentido,
  buses: readonly ObservacionBus[],
): Eta {
  if (buses.length === 0) {
    return noDisponible(codLinea, sentido, MOTIVO_ETA.sinBuses);
  }

  let habiaEstimable = false;
  let mejor: number | null = null;

  for (const bus of buses) {
    const eta = etaBusMinutos(bus);
    if (eta === null) {
      continue;
    }
    habiaEstimable = true;
    if (eta <= COTA_ETA_MINUTOS && (mejor === null || eta < mejor)) {
      mejor = eta;
    }
  }

  if (mejor === null) {
    // Hubo buses, pero ninguno estimable (obsoletos/sin velocidad) o todos por
    // encima de la cota de 60 min: se distingue el motivo para el cliente.
    const motivo = habiaEstimable
      ? MOTIVO_ETA.fueraDeCota
      : MOTIVO_ETA.posicionObsoleta;
    return noDisponible(codLinea, sentido, motivo);
  }

  return {
    codLinea,
    sentido,
    minutos: mejor,
    disponible: true,
    margenMinutos: MARGEN_ETA_MINUTOS,
  };
}

/**
 * Calcula el ETA por cada `(codLinea, sentido)` presente en un conjunto de
 * observaciones de una parada: agrupa por par y aplica
 * {@link seleccionarEtaLinea}. El resultado se ordena por `codLinea` y `sentido`
 * ascendentes para una salida determinista. Es el cálculo que respalda el método
 * de repositorio del map-matching y el endpoint de ETA.
 */
export function calcularEtasPorLinea(
  observaciones: readonly ObservacionBus[],
): Eta[] {
  const grupos = new Map<string, { clave: Eta; buses: ObservacionBus[] }>();

  for (const obs of observaciones) {
    const key = `${obs.codLinea}|${obs.sentido}`;
    const grupo = grupos.get(key);
    if (grupo === undefined) {
      grupos.set(key, {
        clave: { codLinea: obs.codLinea, sentido: obs.sentido } as Eta,
        buses: [obs],
      });
    } else {
      grupo.buses.push(obs);
    }
  }

  const etas: Eta[] = [];
  for (const { clave, buses } of grupos.values()) {
    etas.push(seleccionarEtaLinea(clave.codLinea, clave.sentido, buses));
  }

  etas.sort((a, b) =>
    a.codLinea !== b.codLinea ? a.codLinea - b.codLinea : a.sentido - b.sentido,
  );

  return etas;
}

/** Construye un `Eta` no disponible con su motivo (Requisito 11.6). */
function noDisponible(
  codLinea: CodLinea,
  sentido: Sentido,
  motivo: string,
): Eta {
  return { codLinea, sentido, minutos: null, disponible: false, motivo };
}
