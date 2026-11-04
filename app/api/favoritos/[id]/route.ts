/**
 * `DELETE /api/favoritos/{id}` — baja de un favorito del usuario (tarea 15.1).
 *
 * Requiere sesión (7.6). `204` al eliminarlo, conservando el resto de
 * favoritos (8.7); `404` si no figura en el conjunto del usuario, sin
 * modificar nada (8.8); `400` si el `id` no es un UUID (11.8).
 */

import { malformedRequest, notFound, toResponse } from "@/lib/apiErrors";
import { isUuid } from "@/lib/apiQuery";
import { getAuthProvider } from "@/lib/apiAuth";
import { getRepository } from "@/lib/apiRepository";
import { conSesion } from "@/lib/auth";
import { eliminarFavorito } from "@/lib/favorites";

interface RouteContext {
  params: { id: string };
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const id = context.params?.id?.trim() ?? "";

  return conSesion(request, getAuthProvider(), async ({ userId }) => {
    if (!isUuid(id)) {
      return toResponse(
        malformedRequest(`El identificador de favorito "${id}" no es válido.`),
      );
    }
    const { ok } = await eliminarFavorito(getRepository(), userId, id);
    if (!ok) {
      return toResponse(notFound("El favorito no existe."));
    }
    return new Response(null, { status: 204 });
  });
}
