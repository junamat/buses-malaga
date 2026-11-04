/**
 * `POST /api/auth/logout` — cierra la sesión e invalida su token (Requisito
 * 7.5). Siempre borra la cookie de sesión; `204` aunque no hubiera sesión.
 */

import { toResponse, unavailable } from "@/lib/apiErrors";
import { getAuthProvider } from "@/lib/apiAuth";
import { cookieSesionBorrada, extraerToken } from "@/lib/auth";

export async function POST(request: Request): Promise<Response> {
  const token = extraerToken(request);
  if (token !== null) {
    try {
      await getAuthProvider().logout(token);
    } catch {
      return toResponse(
        unavailable("No se ha podido cerrar la sesión. Inténtalo de nuevo."),
      );
    }
  }
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": cookieSesionBorrada() },
  });
}
