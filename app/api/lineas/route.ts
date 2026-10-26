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

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);

  // 1. Parsear y validar la paginación (las líneas no admiten filtros).
  const paginacion = parsePaginacion(searchParams);
  if (isApiError(paginacion)) {
    return toResponse(paginacion);
  }

  // 2. Consultar la página de líneas y serializar a GeoJSON canónico. El
  //    recorrido no se expone en este endpoint: cada línea se serializa con una
  //    geometría LineString sin vértices.
  const pagina = await getRepository().listLineas(paginacion);
  const entries: LineaConRecorrido[] = pagina.items.map((linea) => ({ linea }));
  const featureCollection = lineasToFeatureCollection(entries);

  return NextResponse.json({ ...featureCollection, next: pagina.next });
}
