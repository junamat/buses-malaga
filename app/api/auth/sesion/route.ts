/**
 * `GET /api/auth/sesion` — estado de la sesión de la petición. Lo usa el
 * frontend para saber si mostrar el formulario de login. Siempre `200`:
 * `{ autenticado: true, userId, email }` o `{ autenticado: false, motivo }`.
 * En `local-postgres` con usuario de desarrollo, una petición sin token
 * aparece como autenticada con ese usuario.
 */

import { NextResponse } from "next/server";

import { toResponse, unavailable } from "@/lib/apiErrors";
import { getAuthProvider } from "@/lib/apiAuth";
import { extraerToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const v = await getAuthProvider().verificarSesion(extraerToken(request));
    return NextResponse.json(
      v.autenticado
        ? { autenticado: true, userId: v.identidad.userId, email: v.identidad.email }
        : { autenticado: false, motivo: v.motivo },
    );
  } catch {
    return toResponse(unavailable("No se ha podido verificar la sesión."));
  }
}
