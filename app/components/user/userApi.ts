/**
 * Cliente de los endpoints de usuario para el frontend (tarea 15.2).
 *
 * La sesión del navegador viaja en la cookie `httpOnly` que fija `POST
 * /api/auth/login`, así que estas funciones no manejan tokens: basta con
 * `credentials: "same-origin"`. Cada llamada devuelve un {@link Resultado}
 * discriminado en lugar de lanzar, para que la UI distinga "requiere sesión"
 * (401, Requisito 7.6) de otros errores y conserve lo que el usuario
 * introdujo.
 *
 * Funciona igual en los tres modos: el frontend no habla con Supabase
 * directamente, sino con la API, que delega en el `AuthProvider` activo.
 */

import type { Favorito } from "@/lib/types";
import type { OpcionAportacion } from "@/lib/contributions";
import type { ReferenciaFavorito } from "@/lib/favorites";

export type FavoritoCliente = Omit<Favorito, "userId">;

export interface SesionCliente {
  userId: string;
  email?: string;
}

export interface AportacionCliente {
  id: string;
  codBus: number;
  opcion: string;
  etiqueta?: string;
  created_at: string;
  expiraEn: string;
}

export type Resultado<T> =
  | { ok: true; valor: T }
  | { ok: false; sesionRequerida: boolean; status: number; mensaje: string };

const ERROR_RED = "No se pudo contactar con el servidor.";

async function llamar<T>(
  url: string,
  init: RequestInit & { json?: unknown } = {},
  leer: (res: Response) => Promise<T> = async (res) => (await res.json()) as T,
): Promise<Resultado<T>> {
  const { json, ...resto } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...resto,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : resto.body,
    });
  } catch {
    return { ok: false, sesionRequerida: false, status: 0, mensaje: ERROR_RED };
  }
  if (!res.ok) {
    const cuerpo = (await res.json().catch(() => null)) as { message?: string; code?: string } | null;
    return {
      ok: false,
      sesionRequerida: res.status === 401 && cuerpo?.code === "sesion_requerida",
      status: res.status,
      mensaje: cuerpo?.message ?? `Error ${res.status}.`,
    };
  }
  return { ok: true, valor: await leer(res) };
}

export async function obtenerSesion(): Promise<SesionCliente | null> {
  const r = await llamar<{ autenticado: boolean; userId?: string; email?: string }>("/api/auth/sesion");
  if (!r.ok || !r.valor.autenticado || r.valor.userId === undefined) return null;
  return { userId: r.valor.userId, email: r.valor.email };
}

export function iniciarSesion(email: string, password: string): Promise<Resultado<SesionCliente>> {
  return llamar("/api/auth/login", { method: "POST", json: { email, password } });
}

export function cerrarSesion(): Promise<Resultado<null>> {
  return llamar("/api/auth/logout", { method: "POST" }, async () => null);
}

export async function listarFavoritos(): Promise<Resultado<FavoritoCliente[]>> {
  const r = await llamar<{ favoritos: FavoritoCliente[] }>("/api/favoritos");
  return r.ok ? { ok: true, valor: r.valor.favoritos } : r;
}

export async function crearFavorito(ref: ReferenciaFavorito): Promise<Resultado<FavoritoCliente>> {
  const r = await llamar<{ favorito: FavoritoCliente }>("/api/favoritos", { method: "POST", json: ref });
  return r.ok ? { ok: true, valor: r.valor.favorito } : r;
}

export function eliminarFavorito(id: string): Promise<Resultado<null>> {
  return llamar(`/api/favoritos/${encodeURIComponent(id)}`, { method: "DELETE" }, async () => null);
}

export async function listarAportaciones(
  codBus: number,
): Promise<Resultado<{ opciones: OpcionAportacion[]; aportaciones: AportacionCliente[] }>> {
  return llamar(`/api/buses/${codBus}/aportaciones`);
}

export async function enviarAportacion(
  codBus: number,
  opcion: string,
): Promise<Resultado<AportacionCliente>> {
  const r = await llamar<{ aportacion: AportacionCliente }>(`/api/buses/${codBus}/aportaciones`, {
    method: "POST",
    json: { opcion },
  });
  return r.ok ? { ok: true, valor: r.valor.aportacion } : r;
}

/** Texto legible de un favorito para la lista del panel. */
export function describirFavorito(f: FavoritoCliente): string {
  switch (f.tipo) {
    case "parada":
      return `Parada ${f.codParada}`;
    case "linea":
      return `Línea ${f.codLinea}`;
    case "parada_linea":
      return `Línea ${f.codLinea} en parada ${f.codParada}`;
  }
}
