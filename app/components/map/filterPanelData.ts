/**
 * Datos de apoyo del panel de filtros del mapa (capa de infraestructura del
 * `Frontend_Mapa`, Requisito 3).
 *
 * El panel de filtros compone sus criterios con la lógica pura de
 * `lib/filters.ts`, que aplica el estado de filtros sobre el **conjunto base**
 * de Buses y Paradas ya cargado en el cliente. Este módulo cubre las dos piezas
 * de datos que esa lógica necesita y que no viven en el conjunto base:
 *
 * - **Catálogo de Líneas** (`fetchLineas`): la lista de Líneas seleccionables
 *   por el usuario, obtenida de `GET /api/lineas`. Cada Línea aporta su
 *   `codLinea` y, si existe, un `nombre` legible para la etiqueta del control.
 *
 * - **Asociación Parada → Líneas** (`fetchParadaLineasLookup`): el filtro por
 *   Línea del Requisito 3.1 oculta también las Paradas no servidas por las
 *   Líneas seleccionadas. El GeoJSON de `GET /api/paradas` solo expone
 *   `codParada` y `nombre` (no las Líneas que atienden a cada Parada), de modo
 *   que la asociación se resuelve consultando `GET /api/paradas?codLinea=X` por
 *   cada Línea seleccionada: el endpoint devuelve exactamente las Paradas
 *   servidas por esa Línea. Con ese resultado se construye el
 *   `ParadaLineasLookup` puro que `lib/filters.apply` inyecta para filtrar
 *   Paradas sin dejar de delegar la semántica del filtro en el módulo puro.
 *
 * Mantener aquí estas consultas deja el componente libre de I/O y conserva la
 * separación entre obtención de datos y presentación que ya sigue
 * `./busLayerData`.
 */

import type { CodLinea, CodParada } from "@/lib/types";
import type { ParadaLineasLookup } from "@/lib/filters";
import { fetchLineasFeatures, fetchParadas } from "./busLayerData";

/** Línea seleccionable en el control de filtro por Línea. */
export interface LineaOpcion {
  readonly codLinea: CodLinea;
  /** Nombre legible de la Línea, o `undefined` si el origen no lo aporta. */
  readonly nombre?: string;
}

/**
 * Obtiene el catálogo de Líneas seleccionables desde `GET /api/lineas`,
 * ordenado por `codLinea` ascendente para una presentación estable. Descarta
 * Líneas sin `codLinea` numérico (no deberían existir, es una salvaguarda).
 */
export async function fetchLineas(
  signal?: AbortSignal,
): Promise<LineaOpcion[]> {
  const features = await fetchLineasFeatures(signal);
  const opciones: LineaOpcion[] = [];
  for (const feature of features) {
    const { codLinea, nombre } = feature.properties;
    if (typeof codLinea !== "number") {
      continue;
    }
    opciones.push({ codLinea, nombre });
  }
  opciones.sort((a, b) => a.codLinea - b.codLinea);
  return opciones;
}

/**
 * Construye la consulta pura `ParadaLineasLookup` (Parada → Líneas) para el
 * conjunto de Líneas seleccionadas, resolviendo la asociación vía
 * `GET /api/paradas?codLinea=X` por cada Línea.
 *
 * El resultado es un `Map` de `codParada` al conjunto de Líneas seleccionadas
 * que la sirven; el lookup devuelto consulta ese `Map`. Las Líneas se
 * consultan en paralelo. Si no hay Líneas seleccionadas se devuelve un lookup
 * vacío: en ese caso `lib/filters.apply` no filtra Paradas por Línea, por lo
 * que el lookup no llega a invocarse.
 *
 * El lookup resultante es puro y determinista (no hace I/O): toda la obtención
 * de datos ocurre aquí, antes de devolverlo.
 */
export async function fetchParadaLineasLookup(
  codLineas: readonly CodLinea[],
  signal?: AbortSignal,
): Promise<ParadaLineasLookup> {
  if (codLineas.length === 0) {
    return () => [];
  }

  const paradaLineas = new Map<CodParada, Set<CodLinea>>();

  await Promise.all(
    codLineas.map(async (codLinea) => {
      const paradas = await fetchParadas(codLinea, signal);
      for (const parada of paradas) {
        const { codParada } = parada.properties;
        const lineas = paradaLineas.get(codParada);
        if (lineas === undefined) {
          paradaLineas.set(codParada, new Set([codLinea]));
        } else {
          lineas.add(codLinea);
        }
      }
    }),
  );

  return (parada) => paradaLineas.get(parada.codParada) ?? [];
}
