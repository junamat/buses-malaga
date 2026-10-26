/**
 * Geometría de dominio como lógica pura (tarea 6.2 y, en fase 2, tarea 20.1).
 *
 * Concentra los cálculos geométricos del sistema que no dependen de PostGIS, de
 * modo que puedan verificarse con `fast-check` y que el cliente pueda ordenar o
 * mostrar distancias sin un viaje al servidor:
 *
 * - {@link distanciaMetros}: distancia sobre la superficie terrestre entre dos
 *   puntos `[lon, lat]`, por la fórmula de Haversine, en metros (Requisito 6.6).
 * - {@link paradasCercanas}: selección de hasta `limite` paradas dentro de un
 *   radio, ordenadas por distancia ascendente (Requisitos 6.2, 6.6).
 *
 * La inclusión geométrica point-in-polygon (Requisito 10.2, fase 2) se añadirá
 * aquí en la tarea 20.1.
 *
 * Convención de coordenadas: siempre numéricas y en orden `[lon, lat]`, igual
 * que en el resto del dominio y en el GeoJSON canónico. El cálculo coincide, a
 * efectos prácticos, con el que PostGIS hace en `findParadasCercanas`
 * (`ST_Distance` sobre `geography`): ambos miden metros geodésicos sobre una
 * Tierra esférica, por lo que la ordenación por cercanía es equivalente.
 *
 * Es lógica pura, sin I/O.
 */

import type { Parada, Position } from "@/lib/types";
import type { ParadaCercana } from "@/lib/ports";

/**
 * Radio medio de la Tierra en metros (modelo esférico, el mismo que usa la
 * geografía de PostGIS para distancias de corto alcance urbanas).
 */
export const RADIO_TIERRA_METROS = 6_371_008.8;

/** Radio por defecto de búsqueda de paradas cercanas: 1000 m (Requisito 6.2). */
export const RADIO_PARADAS_CERCANAS_METROS = 1000;

/** Número máximo de paradas cercanas devueltas: 10 (Requisito 6.2). */
export const MAX_PARADAS_CERCANAS = 10;

/** Convierte grados a radianes. */
function aRadianes(grados: number): number {
  return (grados * Math.PI) / 180;
}

/**
 * Distancia geodésica en metros entre dos puntos `[lon, lat]` por la fórmula de
 * Haversine (Tierra esférica). El resultado es siempre no negativo, simétrico en
 * sus argumentos y cero cuando ambos puntos coinciden.
 *
 * @param a Punto de origen en orden `[lon, lat]`.
 * @param b Punto de destino en orden `[lon, lat]`.
 * @returns Distancia en metros (≥ 0).
 */
export function distanciaMetros(a: Position, b: Position): number {
  const [lonA, latA] = a;
  const [lonB, latB] = b;

  const dLat = aRadianes(latB - latA);
  const dLon = aRadianes(lonB - lonA);
  const latARad = aRadianes(latA);
  const latBRad = aRadianes(latB);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latARad) * Math.cos(latBRad) * Math.sin(dLon / 2) ** 2;
  // `min(1, …)` protege de errores de redondeo que empujen el argumento de
  // `asin` por encima de 1 cuando los dos puntos son casi antípodas.
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));

  return RADIO_TIERRA_METROS * c;
}

/**
 * Selecciona hasta `limite` paradas dentro de `radioMetros` del punto del
 * usuario, ordenadas por distancia ascendente, anotando la distancia en metros
 * (Requisitos 6.2, 6.6).
 *
 * Contrato (Properties 17 y 18):
 *
 * - Solo se incluyen paradas cuya distancia es **≤ `radioMetros`** (el borde
 *   del radio cuenta como dentro).
 * - El resultado tiene como máximo `limite` elementos.
 * - El resultado está ordenado por `distanciaMetros` no decreciente; los empates
 *   se desempatan por `codParada` ascendente para que la selección sea
 *   determinista cuando dos paradas equidistan.
 * - `distanciaMetros` de cada parada es exactamente la que devuelve
 *   {@link distanciaMetros} entre el usuario y esa parada.
 *
 * @param usuario Ubicación del usuario en orden `[lon, lat]`.
 * @param paradas Paradas candidatas.
 * @param radioMetros Radio de búsqueda en metros. Por defecto 1000 m.
 * @param limite Número máximo de resultados. Por defecto 10.
 */
export function paradasCercanas(
  usuario: Position,
  paradas: readonly Parada[],
  radioMetros: number = RADIO_PARADAS_CERCANAS_METROS,
  limite: number = MAX_PARADAS_CERCANAS,
): ParadaCercana[] {
  const dentro: ParadaCercana[] = [];

  for (const parada of paradas) {
    const metros = distanciaMetros(usuario, [parada.lon, parada.lat]);
    if (metros <= radioMetros) {
      dentro.push({ ...parada, distanciaMetros: metros });
    }
  }

  dentro.sort((a, b) => {
    if (a.distanciaMetros !== b.distanciaMetros) {
      return a.distanciaMetros - b.distanciaMetros;
    }
    // Desempate determinista por identificador de parada.
    return a.codParada < b.codParada ? -1 : a.codParada > b.codParada ? 1 : 0;
  });

  const tope = Number.isFinite(limite) && limite > 0 ? Math.floor(limite) : 0;
  return dentro.slice(0, tope);
}
