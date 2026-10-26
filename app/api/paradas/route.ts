/**
 * `GET /api/paradas` — paradas en GeoJSON canónico.
 *
 * Devuelve una `FeatureCollection` con un `Feature` `Point` por parada
 * (coordenadas numéricas en orden `[lon, lat]`), con las propiedades
 * `codParada` y `nombre` (Requisitos 2.3, 11.5).
 *
 * Filtro (query string): `codLinea` restringe a las paradas servidas por esa
 * línea (Requisito 3.1). A diferencia de `/api/buses`, las paradas se filtran
 * por una única línea (el puerto `Repository.listParadas` admite un `codLinea`
 * opcional); si se indican varios, se usa el primero. El `sentido` no aplica a
 * las paradas.
 *
 * Paginación (Requisito 11.3): como máximo 200 elementos por página; la
 * respuesta incluye un cursor `next` a la página siguiente (`null` si no hay
 * más). `limite` y `cursor` controlan la página.
 *
 * Errores canónicos (`lib/apiErrors.ts`): `400` con cuerpo `{ code, message }`
 * si un parámetro presente es sintácticamente incorrecto (Requisito 11.8).
 */

import { NextResponse } from "next/server";

import { paradasToFeatureCollection } from "@/lib/geojson";
import { toResponse } from "@/lib/apiErrors";
import {
  parseCodLineaUnica,
  parsePaginacion,
  isApiError,
} from "@/lib/apiQuery";
import { getRepository } from "@/lib/apiRepository";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);

  // 1. Parsear y validar el filtro por línea y la paginación.
  const codLinea = parseCodLineaUnica(searchParams);
  if (isApiError(codLinea)) {
    return toResponse(codLinea);
  }

  const paginacion = parsePaginacion(searchParams);
  if (isApiError(paginacion)) {
    return toResponse(paginacion);
  }

  // 2. Componer el filtro (ausente = todas las paradas).
  const filtro = codLinea !== undefined ? { codLinea } : undefined;

  // 3. Consultar la página de paradas y serializar a GeoJSON canónico.
  const pagina = await getRepository().listParadas(filtro, paginacion);
  const featureCollection = paradasToFeatureCollection(pagina.items);

  return NextResponse.json({ ...featureCollection, next: pagina.next });
}
