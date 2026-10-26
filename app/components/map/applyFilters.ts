/**
 * Puente entre las capas de datos del mapa (features GeoJSON) y la lógica pura
 * de filtrado de `lib/filters.ts` (Requisito 3).
 *
 * El conjunto base del cliente son arrays de features GeoJSON (`BusFeature`,
 * `ParadaFeature`), mientras que `lib/filters.apply` opera sobre las entidades
 * de dominio (`Bus`, `Parada`). Este módulo adapta en el borde: proyecta los
 * features al dominio, delega **toda** la semántica del filtro (criterio por
 * Línea, por Sentido, composición AND, limpieza y detección de combinación sin
 * resultados) en `lib/filters.apply`, y reconstruye el subconjunto de features
 * a partir de las claves (`codBus`, `codParada`) que superan el filtro.
 *
 * Con esto el componente no reimplementa ninguna regla de filtrado: las
 * propiedades 7–10 del diseño se ejercen sobre `lib/filters.ts`, no aquí. Este
 * módulo solo traduce ida y vuelta entre representaciones.
 */

import type { Bus, Parada } from "@/lib/types";
import {
  apply,
  type FilterState,
  type ParadaLineasLookup,
} from "@/lib/filters";
import type { BusFeature, ParadaFeature } from "./busLayerData";

/** Resultado de aplicar los filtros al conjunto base de features del mapa. */
export interface AppliedFilters {
  /** Buses que superan el filtro, como features (orden del conjunto base). */
  readonly buses: readonly BusFeature[];
  /** Paradas que superan el filtro, como features (orden del conjunto base). */
  readonly paradas: readonly ParadaFeature[];
  /**
   * `true` cuando hay filtros activos y la combinación no deja ningún Bus ni
   * Parada visible (Requisito 3.5). Es `false` sin filtros activos aunque el
   * conjunto base esté vacío.
   */
  readonly sinResultados: boolean;
}

/** Proyecta un `BusFeature` a la entidad de dominio `Bus` que espera `apply`. */
function toBus(feature: BusFeature): Bus {
  const [lon, lat] = feature.geometry.coordinates;
  const { codBus, codLinea, sentido, last_update, captured_at } =
    feature.properties;
  return { codBus, codLinea, sentido, lon, lat, last_update, captured_at };
}

/** Proyecta un `ParadaFeature` a la entidad de dominio `Parada`. */
function toParada(feature: ParadaFeature): Parada {
  const [lon, lat] = feature.geometry.coordinates;
  const { codParada, nombre } = feature.properties;
  return { codParada, nombre, lon, lat };
}

/**
 * Aplica el estado de filtros al conjunto base de features delegando en
 * `lib/filters.apply`, y devuelve el subconjunto de features que lo supera
 * junto con el indicador de "sin resultados".
 *
 * La asociación Parada → Líneas (necesaria para filtrar Paradas por Línea,
 * Requisito 3.1) se inyecta como `paradaLineas`; el componente la resuelve con
 * `filterPanelData.fetchParadaLineasLookup`. Sin filtro por Línea el lookup no
 * llega a usarse.
 *
 * @param state Estado de filtros activos.
 * @param buses Conjunto base de buses (features, sin filtrar).
 * @param paradas Conjunto base de paradas (features, sin filtrar).
 * @param paradaLineas Consulta pura Parada → Líneas para el filtro por Línea.
 */
export function applyFilters(
  state: FilterState,
  buses: readonly BusFeature[],
  paradas: readonly ParadaFeature[],
  paradaLineas: ParadaLineasLookup,
): AppliedFilters {
  const result = apply(
    state,
    {
      buses: buses.map(toBus),
      paradas: paradas.map(toParada),
    },
    paradaLineas,
  );

  // Reconstruye el subconjunto de features por clave de dominio, preservando el
  // orden original del conjunto base.
  const busesVisibles = new Set(result.buses.map((bus) => bus.codBus));
  const paradasVisibles = new Set(
    result.paradas.map((parada) => parada.codParada),
  );

  return {
    buses: buses.filter((feature) =>
      busesVisibles.has(feature.properties.codBus),
    ),
    paradas: paradas.filter((feature) =>
      paradasVisibles.has(feature.properties.codParada),
    ),
    sinResultados: result.sinResultados,
  };
}
