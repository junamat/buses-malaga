/**
 * Configuración de las capas base de OpenStreetMap del conmutador (capa de
 * infraestructura, Requisito 1.2).
 *
 * La lógica pura del estado del mapa (`lib/mapState.ts`) solo conoce el `id` y
 * el `nombre` de cada capa (`BaseLayer`). Los detalles propios de Leaflet —URL
 * de teselas, atribución y zoom máximo del proveedor— viven aquí, en la capa de
 * infraestructura, y se resuelven a partir del `id` de la capa activa.
 *
 * Se definen ≥2 capas base de OSM (Requisito 1.2). Ambas se sirven desde
 * proveedores de teselas de OpenStreetMap:
 * - `osm-standard`: el estilo estándar de openstreetmap.org.
 * - `osm-humanitarian`: el estilo "Humanitarian" (HOT) servido por OSM France.
 */

import type { BaseLayer, LayerId } from "@/lib/mapState";

/** Descriptor de infraestructura de una capa base: metadatos de Leaflet. */
export interface BaseLayerTileConfig extends BaseLayer {
  /** Plantilla de URL de teselas (XYZ) para `L.tileLayer`. */
  readonly url: string;
  /** Atribución exigida por el proveedor de teselas. */
  readonly attribution: string;
  /** Zoom máximo soportado por el proveedor de teselas. */
  readonly maxZoom: number;
}

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * Capas base disponibles en el conmutador, en orden de presentación. El primer
 * elemento es la capa por defecto (Requisito 1.3): exactamente una capa activa
 * al abrir la aplicación.
 */
export const BASE_LAYERS: readonly BaseLayerTileConfig[] = [
  {
    id: "osm-standard",
    nombre: "OpenStreetMap",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: OSM_ATTRIBUTION,
    maxZoom: 19,
  },
  {
    id: "osm-humanitarian",
    nombre: "OSM Humanitarian",
    url: "https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
    attribution: `${OSM_ATTRIBUTION}, Tiles style by <a href="https://www.hotosm.org/">HOT</a>`,
    maxZoom: 20,
  },
] as const;

/** Identificador de la capa base activa por defecto (Requisito 1.3). */
export const DEFAULT_LAYER_ID: LayerId = BASE_LAYERS[0].id;

/**
 * Resuelve la configuración de teselas de una capa a partir de su `id`.
 * Devuelve `undefined` si el `id` no corresponde a ninguna capa conocida.
 */
export function tileConfigFor(
  layerId: LayerId,
): BaseLayerTileConfig | undefined {
  return BASE_LAYERS.find((layer) => layer.id === layerId);
}
