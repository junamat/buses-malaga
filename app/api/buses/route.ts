/**
 * `GET /api/buses` — posiciones vigentes de los buses en GeoJSON canónico.
 *
 * Devuelve una `FeatureCollection` con un `Feature` `Point` por bus (coordenadas
 * numéricas en orden `[lon, lat]`), con las propiedades `codBus`, `codLinea`,
 * `sentido`, `last_update`, `captured_at` y el indicador de obsolescencia
 * derivado de la antigüedad de la captura (Requisitos 2.1, 2.2, 11.5). El
 * repositorio ya resuelve la última captura por vehículo (Requisito 2.5).
 *
 * Filtros (query string, lógica AND; Requisitos 3.1, 3.2, 3.3):
 * - `codLinea`: una o varias líneas (`?codLinea=1&codLinea=7` o `?codLinea=1,7`).
 * - `sentido`: sentido de la línea.
 *
 * Paginación (Requisito 11.3): como máximo 200 elementos por página; la
 * respuesta incluye un cursor `next` a la página siguiente (`null` si no hay
 * más). `limite` y `cursor` controlan la página; el repositorio recorta
 * `limite` al rango `[1, 200]`.
 *
 * Errores canónicos (`lib/apiErrors.ts`): `400` con cuerpo `{ code, message }`
 * si un parámetro presente es sintácticamente incorrecto (Requisito 11.8).
 *
 * El indicador de obsolescencia se calcula con el instante de la petición como
 * referencia (`now`) y el umbral por defecto de 120 s de `lib/geojson.ts`.
 */

import { NextResponse } from "next/server";

import type { FiltroPosiciones } from "@/lib/ports";
import { busesToFeatureCollection } from "@/lib/geojson";
import { toResponse } from "@/lib/apiErrors";
import {
  parseCodLineas,
  parseSentido,
  parsePaginacion,
  isApiError,
} from "@/lib/apiQuery";
import { getRepository } from "@/lib/apiRepository";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);

  // 1. Parsear y validar los filtros y la paginación. Un parámetro presente
  //    pero malformado produce un 400 canónico.
  const codLineas = parseCodLineas(searchParams);
  if (isApiError(codLineas)) {
    return toResponse(codLineas);
  }

  const sentido = parseSentido(searchParams);
  if (isApiError(sentido)) {
    return toResponse(sentido);
  }

  const paginacion = parsePaginacion(searchParams);
  if (isApiError(paginacion)) {
    return toResponse(paginacion);
  }

  // 2. Componer el filtro AND para el repositorio (campos ausentes = sin filtro).
  const filtro: FiltroPosiciones = {};
  if (codLineas !== undefined) {
    filtro.codLineas = codLineas;
  }
  if (sentido !== undefined) {
    filtro.sentido = sentido;
  }

  // 3. Consultar la página de buses y serializar a GeoJSON canónico. El
  //    indicador de obsolescencia usa el instante de la petición como `now`.
  const pagina = await getRepository().listBuses(filtro, paginacion);
  const featureCollection = busesToFeatureCollection(pagina.items, {
    now: Date.now(),
  });

  return NextResponse.json({ ...featureCollection, next: pagina.next });
}
