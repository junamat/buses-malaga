/**
 * Serialización y parseo del GeoJSON canónico de salida del sistema.
 *
 * El GeoJSON canónico (ver `lib/types.ts`) es una `FeatureCollection` con
 * coordenadas numéricas en orden `[lon, lat]`. Este módulo concentra la lógica
 * pura de ida y vuelta entre las entidades de dominio (`Bus`, `Parada`,
 * `Linea`) y esa representación de salida:
 *
 * - **Serialización** (`*ToFeature` / `*ToFeatureCollection`): construye los
 *   `Feature`/`FeatureCollection` canónicos a partir de las entidades.
 * - **Parseo inverso** (`featureTo*` / `featureCollectionTo*`): reconstruye las
 *   entidades de dominio desde el GeoJSON, de modo que
 *   `parse(serialize(x)) === x` para las propiedades intrínsecas de la entidad
 *   (round-trip; Property 33, Requisitos 11.5, 12.3).
 *
 * El módulo es **lógica pura, sin I/O**. En particular, el indicador de
 * obsolescencia de un Bus (Requisito 2.7) no lee el reloj del sistema: se
 * deriva a partir de un instante de referencia (`now`) y un umbral de
 * antigüedad, ambos inyectados por quien llama. Así la salida es determinista y
 * verificable con `fast-check`.
 *
 * Convención de coordenadas: siempre numéricas y en orden `[lon, lat]`.
 */

import type {
  Bus,
  Parada,
  Linea,
  Position,
  GeoJSONPoint,
  GeoJSONLineString,
  GeoJSONFeature,
  GeoJSONFeatureCollection,
  BusFeatureProperties,
  ParadaFeatureProperties,
  LineaFeatureProperties,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Obsolescencia (derivada de la antigüedad de la captura)
// ---------------------------------------------------------------------------

/**
 * Umbral de obsolescencia por defecto, en milisegundos. Coincide con el límite
 * de 120 s a partir del cual la posición más reciente de un Bus se considera
 * demasiado antigua (Requisito 4.6). Quien serializa puede inyectar otro valor.
 */
export const DEFAULT_STALENESS_THRESHOLD_MS = 120_000;

/**
 * Contexto de obsolescencia inyectado en la serialización de Buses. Mantiene la
 * lógica pura: `now` es el instante de referencia (no se lee el reloj del
 * sistema) y `thresholdMs` la antigüedad máxima admitida antes de marcar la
 * posición como obsoleta.
 */
export interface ObsolescenceContext {
  /**
   * Instante de referencia contra el que se mide la antigüedad. Puede ser una
   * marca ISO-8601 o milisegundos epoch.
   */
  now: string | number;
  /** Antigüedad máxima (ms) antes de considerar la posición obsoleta. */
  thresholdMs?: number;
}

/** Convierte una marca de tiempo (ISO-8601 o epoch ms) a milisegundos epoch. */
function toEpochMs(value: string | number): number {
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Marca de tiempo inválida: ${JSON.stringify(value)}`);
  }
  return ms;
}

/**
 * Determina si una captura es obsoleta: su antigüedad respecto a `now` supera
 * estrictamente el umbral. Una captura con el mismo instante que `now` (o en el
 * futuro) nunca es obsoleta.
 */
export function isObsoleta(capturedAt: string, ctx: ObsolescenceContext): boolean {
  const threshold = ctx.thresholdMs ?? DEFAULT_STALENESS_THRESHOLD_MS;
  const age = toEpochMs(ctx.now) - toEpochMs(capturedAt);
  return age > threshold;
}

// ---------------------------------------------------------------------------
// Bus (Point)
// ---------------------------------------------------------------------------

/**
 * Serializa un `Bus` a su `Feature` canónico (geometría `Point` en orden
 * `[lon, lat]`). Las propiedades incluyen `codBus`, `codLinea`, `sentido`,
 * `last_update`, `captured_at` y el indicador de obsolescencia `obsoleto`
 * derivado de la antigüedad de la captura respecto a `ctx` (Requisitos 2.1,
 * 2.2, 2.7).
 */
export function busToFeature(
  bus: Bus,
  ctx: ObsolescenceContext,
): GeoJSONFeature<BusFeatureProperties, GeoJSONPoint> {
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [bus.lon, bus.lat],
    },
    properties: {
      codBus: bus.codBus,
      codLinea: bus.codLinea,
      sentido: bus.sentido,
      last_update: bus.last_update,
      captured_at: bus.captured_at,
      obsoleto: isObsoleta(bus.captured_at, ctx),
    },
  };
}

/** Serializa un conjunto de `Bus` a una `FeatureCollection` canónica. */
export function busesToFeatureCollection(
  buses: readonly Bus[],
  ctx: ObsolescenceContext,
): GeoJSONFeatureCollection<BusFeatureProperties, GeoJSONPoint> {
  return {
    type: "FeatureCollection",
    features: buses.map((bus) => busToFeature(bus, ctx)),
  };
}

/**
 * Parseo inverso: reconstruye un `Bus` desde su `Feature` canónico. El
 * indicador `obsoleto` es derivado y no forma parte de la entidad de dominio,
 * por lo que se descarta en el parseo; el round-trip se define sobre las
 * propiedades intrínsecas del `Bus`.
 */
export function featureToBus(
  feature: GeoJSONFeature<BusFeatureProperties, GeoJSONPoint>,
): Bus {
  const [lon, lat] = feature.geometry.coordinates;
  const { codBus, codLinea, sentido, last_update, captured_at } =
    feature.properties;
  return {
    codBus,
    codLinea,
    sentido,
    lon,
    lat,
    last_update,
    captured_at,
  };
}

/** Parseo inverso de una `FeatureCollection` de Buses a entidades de dominio. */
export function featureCollectionToBuses(
  fc: GeoJSONFeatureCollection<BusFeatureProperties, GeoJSONPoint>,
): Bus[] {
  return fc.features.map(featureToBus);
}

// ---------------------------------------------------------------------------
// Parada (Point)
// ---------------------------------------------------------------------------

/**
 * Serializa una `Parada` a su `Feature` canónico (geometría `Point` en orden
 * `[lon, lat]`), exponiendo `codParada` y `nombre` como propiedades
 * (Requisitos 2.3, 2.4).
 */
export function paradaToFeature(
  parada: Parada,
): GeoJSONFeature<ParadaFeatureProperties, GeoJSONPoint> {
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [parada.lon, parada.lat],
    },
    properties: {
      codParada: parada.codParada,
      nombre: parada.nombre,
    },
  };
}

/** Serializa un conjunto de `Parada` a una `FeatureCollection` canónica. */
export function paradasToFeatureCollection(
  paradas: readonly Parada[],
): GeoJSONFeatureCollection<ParadaFeatureProperties, GeoJSONPoint> {
  return {
    type: "FeatureCollection",
    features: paradas.map(paradaToFeature),
  };
}

/** Parseo inverso: reconstruye una `Parada` desde su `Feature` canónico. */
export function featureToParada(
  feature: GeoJSONFeature<ParadaFeatureProperties, GeoJSONPoint>,
): Parada {
  const [lon, lat] = feature.geometry.coordinates;
  return {
    codParada: feature.properties.codParada,
    nombre: feature.properties.nombre,
    lon,
    lat,
  };
}

/** Parseo inverso de una `FeatureCollection` de Paradas a entidades de dominio. */
export function featureCollectionToParadas(
  fc: GeoJSONFeatureCollection<ParadaFeatureProperties, GeoJSONPoint>,
): Parada[] {
  return fc.features.map(featureToParada);
}

// ---------------------------------------------------------------------------
// Linea (LineString)
// ---------------------------------------------------------------------------

/**
 * La entidad de dominio `Linea` no lleva geometría propia (su recorrido vive en
 * los `shapes` del GTFS, materializados como LINESTRING en PostGIS). Para
 * serializar una Linea al GeoJSON canónico se acompaña, opcionalmente, de la
 * polilínea de su recorrido como lista de coordenadas `[lon, lat]`, junto con
 * el `sentido` al que corresponde esa polilínea cuando aplica.
 */
export interface LineaConRecorrido {
  linea: Linea;
  /**
   * Coordenadas del recorrido en orden `[lon, lat]`. Si se omite o está vacía,
   * la geometría resultante es un `LineString` sin vértices (la Linea existe
   * pero su recorrido no está disponible).
   */
  recorrido?: readonly Position[];
  /** Sentido al que corresponde el recorrido, si procede. */
  sentido?: number;
}

/**
 * Serializa una `Linea` (con su recorrido opcional) a su `Feature` canónico con
 * geometría `LineString` en orden `[lon, lat]`. Las propiedades exponen
 * `codLinea`, `nombre` (si existe) y `sentido` (si se indicó).
 */
export function lineaToFeature(
  entry: LineaConRecorrido,
): GeoJSONFeature<LineaFeatureProperties, GeoJSONLineString> {
  const properties: LineaFeatureProperties = {
    codLinea: entry.linea.codLinea,
  };
  if (entry.linea.nombre !== undefined) {
    properties.nombre = entry.linea.nombre;
  }
  if (entry.sentido !== undefined) {
    properties.sentido = entry.sentido;
  }

  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: (entry.recorrido ?? []).map(
        ([lon, lat]): Position => [lon, lat],
      ),
    },
    properties,
  };
}

/** Serializa un conjunto de Lineas (con recorrido) a una `FeatureCollection`. */
export function lineasToFeatureCollection(
  entries: readonly LineaConRecorrido[],
): GeoJSONFeatureCollection<LineaFeatureProperties, GeoJSONLineString> {
  return {
    type: "FeatureCollection",
    features: entries.map(lineaToFeature),
  };
}

/**
 * Parseo inverso: reconstruye una `Linea` con su recorrido y sentido desde su
 * `Feature` canónico.
 */
export function featureToLinea(
  feature: GeoJSONFeature<LineaFeatureProperties, GeoJSONLineString>,
): LineaConRecorrido {
  const linea: Linea = { codLinea: feature.properties.codLinea };
  if (feature.properties.nombre !== undefined) {
    linea.nombre = feature.properties.nombre;
  }

  const entry: LineaConRecorrido = {
    linea,
    recorrido: feature.geometry.coordinates.map(
      ([lon, lat]): Position => [lon, lat],
    ),
  };
  if (feature.properties.sentido !== undefined) {
    entry.sentido = feature.properties.sentido;
  }
  return entry;
}

/** Parseo inverso de una `FeatureCollection` de Lineas a entidades de dominio. */
export function featureCollectionToLineas(
  fc: GeoJSONFeatureCollection<LineaFeatureProperties, GeoJSONLineString>,
): LineaConRecorrido[] {
  return fc.features.map(featureToLinea);
}
