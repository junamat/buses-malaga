/**
 * `GET /api/lineas` — líneas en GeoJSON canónico.
 *
 * Devuelve una `FeatureCollection` con un `Feature` `LineString` por línea, con
 * la propiedad `codLinea` y, si existe, `nombre` (Requisitos 11.1, 11.5). La
 * entidad de dominio `Linea` no lleva geometría propia (su recorrido vive en
 * los `shapes` del GTFS), por lo que en este endpoint la geometría es un
 * `LineString` sin vértices: la línea existe aunque su recorrido no se exponga
 * aquí. Mantener la salida como GeoJSON canónico (en lugar de un JSON ad-hoc)
 * da un formato único y homogéneo a todos los listados geográficos.
 *
 * Paginación (Requisito 11.3): como máximo 200 elementos por página; la
 * respuesta incluye un cursor `next` a la página siguiente (`null` si no hay
 * más). `limite` y `cursor` controlan la página.
 *
 * Errores canónicos (`lib/apiErrors.ts`): `400` con cuerpo `{ code, message }`
 * si un parámetro presente es sintácticamente incorrecto (Requisito 11.8).
 */

import { NextResponse } from "next/server";

import { lineasToFeatureCollection, type LineaConRecorrido } from "@/lib/geojson";
import { toResponse } from "@/lib/apiErrors";
import { parsePaginacion, isApiError } from "@/lib/apiQuery";
import { getRepository } from "@/lib/apiRepository";
import type { CodLinea, DestinoGtfs, Linea, Sentido } from "@/lib/types";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);

  // 1. Parsear y validar la paginación (las líneas no admiten filtros).
  const paginacion = parsePaginacion(searchParams);
  if (isApiError(paginacion)) {
    return toResponse(paginacion);
  }

  // 2. Consultar la página de líneas y los Destinos conocidos por
  //    `(codLinea, sentido)`. El recorrido no se expone en este endpoint: cada
  //    línea se serializa con una geometría LineString sin vértices.
  const repo = getRepository();
  const [pagina, destinos] = await Promise.all([
    repo.listLineas(paginacion),
    repo.listDestinos(),
  ]);

  // 3. Construir las entradas a serializar. Una línea con Destinos conocidos se
  //    expone con un Feature por cada Sentido (con su `sentido` y `destino`);
  //    una línea sin Destino conocido se expone con un único Feature sin esas
  //    propiedades, preservando la salida base (Requisitos 2.8, 11.10).
  const entries = buildLineaEntries(pagina.items, destinos);
  const featureCollection = lineasToFeatureCollection(entries);

  return NextResponse.json({ ...featureCollection, next: pagina.next });
}

/**
 * Compone las entradas de serialización de líneas: para cada línea, un Feature
 * por Sentido con Destino conocido (ordenado por `sentido`), o un único Feature
 * sin Sentido/Destino cuando la línea no tiene Destinos. Se omite la propiedad
 * `destino` en lugar de emitir un valor vacío (Requisitos 2.8, 11.10).
 */
function buildLineaEntries(
  lineas: readonly Linea[],
  destinos: readonly DestinoGtfs[],
): LineaConRecorrido[] {
  // codLinea → (sentido → destino), ordenable por sentido de forma determinista.
  const porLinea = new Map<CodLinea, Map<Sentido, string>>();
  for (const { codLinea, sentido, destino } of destinos) {
    let sentidos = porLinea.get(codLinea);
    if (sentidos === undefined) {
      sentidos = new Map<Sentido, string>();
      porLinea.set(codLinea, sentidos);
    }
    sentidos.set(sentido, destino);
  }

  const entries: LineaConRecorrido[] = [];
  for (const linea of lineas) {
    const sentidos = porLinea.get(linea.codLinea);
    if (sentidos === undefined || sentidos.size === 0) {
      entries.push({ linea });
      continue;
    }
    const sentidosOrdenados = [...sentidos.keys()].sort((a, b) => a - b);
    for (const sentido of sentidosOrdenados) {
      entries.push({ linea, sentido, destino: sentidos.get(sentido) });
    }
  }
  return entries;
}
