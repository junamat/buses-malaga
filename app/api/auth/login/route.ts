/**
 * `POST /api/auth/login` — inicio de sesión con `{ email, password }` a través
 * del `AuthProvider` del modo activo (Requisitos 7.1, 7.3, 7.4).
 *
 * - `200 { userId, email, expiraEn, token }` y cookie de sesión `httpOnly`. El
 *   `token` se devuelve también para clientes de terceros, que lo envían como
 *   `Authorization: Bearer <token>`.
 * - `401` credenciales incorrectas; `429` identidad bloqueada temporalmente;
 *   `503` proveedor de identidad no disponible; `400` cuerpo malformado o
 *   campos ausentes.
 */

import { NextResponse } from "next/server";

import {
  invalidCredentials,
  loginLocked,
  malformedRequest,
  toResponse,
  unavailable,
  validateRequiredParams,
} from "@/lib/apiErrors";
import { isApiError, parseJsonBody } from "@/lib/apiQuery";
import { getAuthProvider } from "@/lib/apiAuth";
import { cookieSesion } from "@/lib/auth";
import { AuthError } from "@/lib/ports";

export async function POST(request: Request): Promise<Response> {
  const cuerpo = await parseJsonBody(request);
  if (isApiError(cuerpo)) {
    return toResponse(cuerpo);
  }
  const datos = cuerpo.datos as Record<string, unknown> | null;
  if (typeof datos !== "object" || datos === null || Array.isArray(datos)) {
    return toResponse(malformedRequest("El cuerpo debe ser un objeto JSON."));
  }
  const { email, password } = datos;
  if (
    (email !== undefined && typeof email !== "string") ||
    (password !== undefined && typeof password !== "string")
  ) {
    return toResponse(malformedRequest('"email" y "password" deben ser texto.'));
  }
  const faltan = validateRequiredParams(["email", "password"], {
    email: email as string | undefined,
    password: password as string | undefined,
  });
  if (faltan !== null) {
    return toResponse(faltan);
  }

  try {
    const sesion = await getAuthProvider().login(email as string, password as string);
    const res = NextResponse.json({
      userId: sesion.identidad.userId,
      email: sesion.identidad.email,
      expiraEn: sesion.expiraEn,
      token: sesion.token,
    });
    res.headers.append("set-cookie", cookieSesion(sesion.token, sesion.expiraEn));
    return res;
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.motivo === "credenciales_invalidas") return toResponse(invalidCredentials());
      if (error.motivo === "bloqueado") return toResponse(loginLocked());
    }
    return toResponse(
      unavailable("El servicio de autenticación no está disponible. Inténtalo de nuevo."),
    );
  }
}
