/**
 * `GET /api/paradas/cercanas` — paradas cercanas a una ubicación.
 *
 * Devuelve hasta 10 paradas dentro de 1000 m del punto `lat`/`lon` del usuario,
 * ordenadas por distancia ascendente, como `FeatureCollection` canónica con la
 * distancia en metros en cada `Feature` (Requisitos 6.2, 6.6). El radio y el
 * límite son fijos por el diseño; la distancia la calcula PostGIS en el
 * repositorio (`findParadasCercanas`).
 *
 * Parámetros (query string): `lat` y `lon` son **obligatorios** y deben ser
 * números finitos en rango geográfico. Su ausencia produce `400` con los
 * parámetros ausentes identificados (Requisito 11.9); un valor no numérico o
 * fuera de rango produce `400` de petición malformada (Requisito 11.8).
 *
 * App Router resuelve esta ruta estática con prioridad sobre la dinámica
 * `/api/paradas/[codParada]`, por lo que `cercanas` no colisiona con ella.
 */

import { NextResponse } from "next/server";

import { paradasCercanasToFeatureCollection } from "@/lib/geojson";
import {
  RADIO_PARADAS_CERCANAS_METROS,
  MAX_PARADAS_CERCANAS,
} from "@/lib/geometry";
import { toResponse } from "@/lib/apiErrors";
import { parseUbicacion, isApiError } from "@/lib/apiQuery";
import { getRepository } from "@/lib/apiRepository";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);

  // 1. Parsear y validar la ubicación obligatoria del usuario.
  const ubicacion = parseUbicacion(searchParams);
  if (isApiError(ubicacion)) {
    return toResponse(ubicacion);
  }
  const [lon, lat] = ubicacion;

  // 2. Consultar las paradas cercanas (radio y límite fijos) y serializar.
  const paradas = await getRepository().findParadasCercanas(
    lon,
    lat,
    RADIO_PARADAS_CERCANAS_METROS,
    MAX_PARADAS_CERCANAS,
  );

  return NextResponse.json(paradasCercanasToFeatureCollection(paradas));
}
