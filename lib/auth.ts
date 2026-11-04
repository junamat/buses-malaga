/**
 * Verificación de sesión en el borde de la API sobre el puerto `AuthProvider`
 * (tarea 14.1, Requisito 7.6).
 *
 * Los route handlers protegidos envuelven su lógica con {@link conSesion}: se
 * extrae el token de la petición, se verifica con el `AuthProvider` del modo
 * activo y, solo si hay sesión válida, se ejecuta la operación con la
 * identidad resuelta. Sin sesión, la operación **no se ejecuta** (nada llega al
 * repositorio) y se responde `401` devolviendo intactos los datos introducidos,
 * para que el cliente los conserve y reintente tras iniciar sesión.
 *
 * El token se acepta por cabecera `Authorization: Bearer <token>` (clientes de
 * terceros) o por la cookie de sesión `httpOnly` que fija `POST
 * /api/auth/login` (el frontend). El contrato es idéntico en los tres modos;
 * solo cambia el adaptador inyectado.
 */

import type { AuthProvider, Identidad } from "@/lib/ports";
import { sessionRequired, toResponse, unavailable } from "@/lib/apiErrors";

/** Nombre de la cookie de sesión del frontend. */
export const SESSION_COOKIE = "bm_session";

/** Token de sesión de la petición, o `null` si no trae ninguno. */
export function extraerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match !== null && match[1].trim() !== "") {
      return match[1].trim();
    }
  }
  const cookies = request.headers.get("cookie");
  if (cookies !== null) {
    for (const parte of cookies.split(";")) {
      const [nombre, ...resto] = parte.trim().split("=");
      if (nombre === SESSION_COOKIE) {
        const valor = decodeURIComponent(resto.join("="));
        return valor === "" ? null : valor;
      }
    }
  }
  return null;
}

/**
 * Ejecuta `operacion` solo si la petición trae una sesión válida.
 *
 * @param datos Datos introducidos por el usuario (p. ej. el cuerpo del POST),
 *   devueltos sin modificar en el `401` si no hay sesión.
 */
export async function conSesion(
  request: Request,
  auth: AuthProvider,
  operacion: (identidad: Identidad) => Promise<Response>,
  datos?: unknown,
): Promise<Response> {
  let verificacion;
  try {
    verificacion = await auth.verificarSesion(extraerToken(request));
  } catch {
    return toResponse(
      unavailable("No se ha podido verificar la sesión. Inténtalo de nuevo."),
    );
  }
  if (!verificacion.autenticado) {
    return toResponse(sessionRequired(datos));
  }
  return operacion(verificacion.identidad);
}

/** Cabecera `Set-Cookie` que fija la cookie de sesión hasta `expiraEn`. */
export function cookieSesion(token: string, expiraEn: string): string {
  const maxAge = Math.max(
    0,
    Math.floor((Date.parse(expiraEn) - Date.now()) / 1000),
  );
  return (
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; ` +
    `SameSite=Lax; Max-Age=${maxAge}${secureFlag()}`
  );
}

/** Cabecera `Set-Cookie` que borra la cookie de sesión. */
export function cookieSesionBorrada(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag()}`;
}

function secureFlag(): string {
  return process.env.NODE_ENV === "production" ? "; Secure" : "";
}
