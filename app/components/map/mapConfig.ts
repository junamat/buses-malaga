/**
 * Constantes de vista inicial del mapa (capa de infraestructura, Requisitos
 * 1.1, 1.3).
 *
 * El centro corresponde al área de servicio de la EMT de Málaga (centro urbano
 * de Málaga). El zoom inicial se fija dentro del rango exigido [10, 16]
 * (Requisito 1.3); `lib/mapState.createMapState` lo recorta además al rango
 * global permitido [1, 19] (Requisito 1.6).
 */

import type { MapCenter } from "@/lib/mapState";

/**
 * Centro inicial del mapa: casco urbano de Málaga, dentro del área de servicio
 * de la EMT. Orden `[lon, lat]` coherente con el dominio y el GeoJSON canónico.
 */
export const EMT_MALAGA_CENTER: MapCenter = {
  lon: -4.421,
  lat: 36.72,
};

/**
 * Zoom inicial al abrir la aplicación. Debe estar en [10, 16] (Requisito 1.3);
 * 13 encuadra el casco urbano de Málaga.
 */
export const INITIAL_ZOOM = 13;
