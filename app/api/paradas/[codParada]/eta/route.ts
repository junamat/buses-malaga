/**
 * `GET /api/paradas/{codParada}/eta` — estimación de llegada por línea/sentido.
 *
 * Invoca el `Estimador_ETA` (map-matching PostGIS + lógica pura de `lib/eta.ts`)
 * para la parada indicada y devuelve, por cada línea/sentido que la sirve, el
 * ETA del siguiente bus: minutos enteros con margen ±1 cuando hay estimación, o
 * `{ minutos: null, disponible: false, motivo }` cuando no la hay (Requisitos
 * 4.1, 11.2, 11.6). La ausencia de ETA es un resultado válido (HTTP 200), no un
 * error (Property 34).
 *
 * Contrato HTTP:
 *
 * - `404` (Requisito 11.7) si la parada no existe.
 * - `200` con `{ codParada, etas: Eta[] }` si existe, aunque `etas` esté vacío o
 *   todas las entradas sean no disponibles.
 *
 * La respuesta **nunca** incluye los minutos oficiales de calibración
 * (`official_minutes`): el estimador de producción no los consume (Requisito
 * 5.4, Property 16).
 */

import { NextResponse } from "next/server";

import { toResponse, notFound, missingParams } from "@/lib/apiErrors";
import { getRepository } from "@/lib/apiRepository";

interface RouteContext {
  params: { codParada: string };
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const codParada = context.params?.codParada?.trim();

  // El segmento dinámico siempre llega, pero un valor vacío es una petición sin
  // el parámetro obligatorio (Requisito 11.9).
  if (codParada === undefined || codParada === "") {
    return toResponse(missingParams(["codParada"]));
  }

  const repository = getRepository();

  // Distinguir "parada inexistente" (404) de "parada sin ETA disponible" (200):
  // solo lo primero es un error de recurso no encontrado (Requisito 11.7).
  const parada = await repository.findParada(codParada);
  if (parada === null) {
    return toResponse(
      notFound(`No existe ninguna parada con codParada "${codParada}".`),
    );
  }

  const etas = await repository.etaPorParada(codParada);
  return NextResponse.json({ codParada, etas });
}
