/**
 * Estado del mapa interactivo (lógica pura, sin I/O ni dependencia de Leaflet).
 *
 * Este módulo implementa la parte lógica del Requisito 1: el conmutador de
 * capas base y el estado de vista (centro y zoom). Se mantiene libre de
 * dependencias de la plataforma (Leaflet, DOM) para que las correctness
 * properties (Properties 1, 2, 3) puedan verificarlo con fast-check. El
 * componente `Frontend_Mapa` consume este módulo y proyecta su resultado sobre
 * Leaflet; el renderizado, las teselas OSM y el manejo de errores de carga
 * (Requisitos 1.1, 1.5) viven en la capa de infraestructura, no aquí.
 *
 * Decisiones de modelado relevantes:
 *
 * - El estado (`MapState`) es un **value object inmutable**: las transiciones
 *   devuelven un estado nuevo y no mutan el recibido (igual que `lib/filters.ts`).
 * - El conmutador de capas (Requisito 1.2) mantiene **exactamente una** capa
 *   base activa en todo momento: el estado guarda el `id` de la capa activa, no
 *   un conjunto de banderas que pudiera quedar inconsistente. Si el estado se
 *   construye desde una lista de capas, la invariante "exactamente una activa"
 *   es estructural, no una comprobación en tiempo de ejecución.
 * - Conmutar de capa (Requisito 1.4) preserva **centro y zoom**: `switchLayer`
 *   solo cambia `activeLayerId`; `center` y `zoom` se copian sin tocar.
 * - El zoom (Requisito 1.6) se **recorta** al rango permitido [1, 19] en todas
 *   las transiciones que lo fijan, de modo que ningún estado alcanzable queda
 *   fuera de rango.
 */

// ---------------------------------------------------------------------------
// Constantes de rango de zoom (Requisito 1.6)
// ---------------------------------------------------------------------------

/** Nivel de zoom mínimo permitido (alejamiento máximo). */
export const MIN_ZOOM = 1;

/** Nivel de zoom máximo permitido (acercamiento máximo). */
export const MAX_ZOOM = 19;

// ---------------------------------------------------------------------------
// Tipos del estado del mapa (value objects inmutables)
// ---------------------------------------------------------------------------

/** Identificador estable de una capa base del conmutador. */
export type LayerId = string;

/**
 * Capa base de OpenStreetMap seleccionable en el conmutador. El identificador
 * (`id`) es la clave estable usada para marcar la capa activa; `nombre` es la
 * etiqueta legible mostrada en el conmutador. La URL de teselas y demás detalles
 * de Leaflet se resuelven en la capa de infraestructura y no forman parte de
 * este modelo puro.
 */
export interface BaseLayer {
  readonly id: LayerId;
  readonly nombre: string;
}

/**
 * Centro del mapa en coordenadas geográficas. Orden `[lon, lat]` coherente con
 * el resto del dominio y el GeoJSON canónico de salida.
 */
export interface MapCenter {
  readonly lon: number;
  readonly lat: number;
}

/**
 * Estado del mapa: capas base disponibles, capa activa, centro y nivel de zoom.
 * Inmutable: las transiciones devuelven un estado nuevo.
 *
 * Invariantes garantizadas por construcción:
 * - `layers` contiene al menos una capa (Requisito 1.2 exige ≥ 2 para el
 *   conmutador; el modelo no impide menos, pero `createMapState` las valida).
 * - `activeLayerId` identifica **exactamente una** capa de `layers`.
 * - `zoom` está dentro de `[MIN_ZOOM, MAX_ZOOM]`.
 */
export interface MapState {
  readonly layers: readonly BaseLayer[];
  readonly activeLayerId: LayerId;
  readonly center: MapCenter;
  readonly zoom: number;
}

// ---------------------------------------------------------------------------
// Recorte del zoom (Requisito 1.6)
// ---------------------------------------------------------------------------

/**
 * Recorta un nivel de zoom solicitado al rango permitido [MIN_ZOOM, MAX_ZOOM].
 * Valores fuera de rango se llevan al extremo más próximo. Los valores no
 * finitos (`NaN`, `±Infinity`) se tratan como fuera de rango: `NaN` cae al
 * mínimo y `±Infinity` a su extremo correspondiente.
 */
export function clampZoom(zoom: number): number {
  if (Number.isNaN(zoom)) {
    return MIN_ZOOM;
  }
  if (zoom < MIN_ZOOM) {
    return MIN_ZOOM;
  }
  if (zoom > MAX_ZOOM) {
    return MAX_ZOOM;
  }
  return zoom;
}

// ---------------------------------------------------------------------------
// Construcción del estado inicial
// ---------------------------------------------------------------------------

/**
 * Error lanzado cuando se intenta construir un estado de mapa inválido: sin
 * capas, o con una capa activa inicial que no pertenece a la lista de capas.
 */
export class InvalidMapStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMapStateError";
  }
}

/**
 * Construye el estado inicial del mapa a partir de las capas base disponibles,
 * la capa activa por defecto, el centro y el zoom inicial.
 *
 * - Garantiza la invariante "exactamente una capa activa" (Requisito 1.2):
 *   `activeLayerId` debe identificar una capa presente en `layers`.
 * - Recorta el `zoom` inicial al rango permitido (Requisito 1.6). El rango de
 *   zoom inicial recomendado (10–16, Requisito 1.3) es responsabilidad del
 *   llamante; aquí solo se garantiza que el valor quede dentro de [1, 19].
 *
 * @throws {InvalidMapStateError} si `layers` está vacía o si `activeLayerId` no
 *   corresponde a ninguna capa de `layers`.
 */
export function createMapState(params: {
  layers: readonly BaseLayer[];
  activeLayerId: LayerId;
  center: MapCenter;
  zoom: number;
}): MapState {
  const { layers, activeLayerId, center, zoom } = params;

  if (layers.length === 0) {
    throw new InvalidMapStateError(
      "El estado del mapa requiere al menos una capa base.",
    );
  }
  if (!layers.some((layer) => layer.id === activeLayerId)) {
    throw new InvalidMapStateError(
      `La capa activa "${activeLayerId}" no pertenece a las capas disponibles.`,
    );
  }

  return {
    layers,
    activeLayerId,
    center,
    zoom: clampZoom(zoom),
  };
}

// ---------------------------------------------------------------------------
// Transiciones del estado (inmutables)
// ---------------------------------------------------------------------------

/**
 * Conmuta a la capa base indicada (Requisitos 1.2, 1.4).
 *
 * Devuelve un estado nuevo con `activeLayerId` apuntando a la capa seleccionada
 * y con el **centro y el zoom sin cambios**. Como el estado guarda un único
 * identificador de capa activa, la invariante "exactamente una activa" se
 * mantiene automáticamente.
 *
 * Si `layerId` no corresponde a ninguna capa disponible, el estado se devuelve
 * sin cambios: una selección inexistente no puede dejar el mapa sin capa activa
 * ni cambiar la capa previa (coherente con conservar la capa previa del
 * Requisito 1.5). No muta el estado recibido.
 */
export function switchLayer(state: MapState, layerId: LayerId): MapState {
  if (layerId === state.activeLayerId) {
    return state;
  }
  if (!state.layers.some((layer) => layer.id === layerId)) {
    return state;
  }
  return { ...state, activeLayerId: layerId };
}

/**
 * Fija el nivel de zoom del mapa recortándolo al rango permitido (Requisito
 * 1.6). El centro y la capa activa quedan sin cambios. No muta el estado
 * recibido.
 */
export function setZoom(state: MapState, zoom: number): MapState {
  return { ...state, zoom: clampZoom(zoom) };
}

/**
 * Desplaza (pan) el mapa a un nuevo centro (Requisito 1.6). El zoom y la capa
 * activa quedan sin cambios. No muta el estado recibido.
 */
export function panTo(state: MapState, center: MapCenter): MapState {
  return { ...state, center };
}

/** Devuelve la capa base actualmente activa. */
export function activeLayer(state: MapState): BaseLayer {
  // Garantizado por la invariante de construcción/transiciones: siempre existe.
  const layer = state.layers.find((l) => l.id === state.activeLayerId);
  if (layer === undefined) {
    // Inalcanzable si el estado se construyó con createMapState y solo se mutó
    // con las transiciones de este módulo.
    throw new InvalidMapStateError(
      `Estado inconsistente: capa activa "${state.activeLayerId}" ausente.`,
    );
  }
  return layer;
}
