/**
 * `GET/POST /api/favoritos` — favoritos del usuario autenticado (tarea 15.1).
 *
 * Ambas operaciones requieren sesión (Requisito 7.6): sin ella se responde
 * `401` y, en el `POST`, el cuerpo enviado vuelve intacto en `datos`.
 *
 * - `GET`  → `200 { favoritos }`, posiblemente vacío (8.5, 8.6).
 * - `POST` con `{ tipo, codParada?, codLinea? }`:
 *   - `201 { favorito }` al crearlo (8.1–8.3);
 *   - `200 { favorito }` si ya existía, sin duplicarlo (8.9);
 *   - `422` si la Parada/Linea no existe (8.4);
 *   - `409` si el usuario ya tiene 500 favoritos (8.10);
 *   - `400` si el cuerpo es malformado o faltan campos (11.8, 11.9).
 */

import { NextResponse } from "next/server";

import {
  favoritesLimit,
  malformedRequest,
  missingParams,
  toResponse,
  unprocessable,
} from "@/lib/apiErrors";
import { isApiError, parseJsonBody } from "@/lib/apiQuery";
import { getAuthProvider } from "@/lib/apiAuth";
import { getRepository } from "@/lib/apiRepository";
import { conSesion } from "@/lib/auth";
import {
  LIMITE_FAVORITOS,
  crearFavorito,
  listarFavoritos,
  validarReferencia,
} from "@/lib/favorites";
import type { Favorito } from "@/lib/types";

/** Representación pública de un favorito (sin el `userId` del dueño). */
function favoritoPublico(f: Favorito): Omit<Favorito, "userId"> {
  const { userId: _userId, ...resto } = f;
  return resto;
}

export async function GET(request: Request): Promise<Response> {
  return conSesion(request, getAuthProvider(), async ({ userId }) => {
    const favoritos = await listarFavoritos(getRepository(), userId);
    return NextResponse.json({ favoritos: favoritos.map(favoritoPublico) });
  });
}

export async function POST(request: Request): Promise<Response> {
  const cuerpo = await parseJsonBody(request);
  if (isApiError(cuerpo)) {
    return toResponse(cuerpo);
  }
  const { datos } = cuerpo;

  return conSesion(
    request,
    getAuthProvider(),
    async ({ userId }) => {
      const validacion = validarReferencia(datos);
      if (!validacion.ok) {
        return toResponse(
          "ausentes" in validacion
            ? missingParams(validacion.ausentes)
            : malformedRequest(validacion.message),
        );
      }

      const resultado = await crearFavorito(getRepository(), userId, validacion.referencia);
      if (!resultado.ok) {
        return toResponse(
          resultado.motivo === "limite_alcanzado"
            ? favoritesLimit(LIMITE_FAVORITOS)
            : unprocessable("El elemento que intentas marcar como favorito no existe."),
        );
      }
      return NextResponse.json(
        { favorito: favoritoPublico(resultado.favorito) },
        { status: resultado.creado ? 201 : 200 },
      );
    },
    datos,
  );
}
