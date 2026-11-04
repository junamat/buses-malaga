/**
 * Servicio_Aportaciones: catálogo, validación y vigencia de las aportaciones
 * por vehículo (tarea 13.2).
 *
 * - Catálogo predefinido de como máximo 10 opciones (Requisito 9.2).
 * - Una aportación es válida si su opción pertenece al catálogo (9.5) y su
 *   `codBus` es un vehículo conocido (9.4). La opción se comprueba primero
 *   porque no requiere consultar la base de datos.
 * - Vigencia de 60 minutos desde el registro: una aportación con exactamente
 *   60 min de antigüedad ya ha expirado (9.6).
 *
 * La lógica de decisión es pura (Properties 26–29); `registrarAportacion` y
 * `consultarAportaciones` la aplican sobre el puerto `Repository`.
 */

import type { Repository } from "@/lib/ports";
import type { Aportacion, CodBus } from "@/lib/types";

/** Ventana de vigencia de una aportación en milisegundos (60 min). */
export const VIGENCIA_APORTACION_MS = 60 * 60 * 1000;

export interface OpcionAportacion {
  id: string;
  etiqueta: string;
}

/** Catálogo predefinido de opciones (≤ 10, Requisito 9.2). */
export const OPCIONES_APORTACION: readonly OpcionAportacion[] = [
  { id: "lleno", etiqueta: "Va lleno" },
  { id: "con_sitio", etiqueta: "Hay sitio libre" },
  { id: "retraso", etiqueta: "Va con retraso" },
  { id: "aire_averiado", etiqueta: "Aire acondicionado averiado" },
  { id: "rampa_averiada", etiqueta: "Rampa de accesibilidad averiada" },
  { id: "sucio", etiqueta: "Interior sucio" },
  { id: "incidencia", etiqueta: "Incidencia a bordo" },
  { id: "desvio", etiqueta: "Circula desviado" },
];

export function esOpcionValida(opcion: unknown): opcion is string {
  return (
    typeof opcion === "string" && OPCIONES_APORTACION.some((o) => o.id === opcion)
  );
}

export function etiquetaOpcion(opcion: string): string | undefined {
  return OPCIONES_APORTACION.find((o) => o.id === opcion)?.etiqueta;
}

export type MotivoRechazo = "opcion_invalida" | "bus_desconocido";

/** Decide si una aportación es admisible. `null` si es válida. */
export function validarAportacion(
  opcion: unknown,
  busConocido: boolean,
): MotivoRechazo | null {
  if (!esOpcionValida(opcion)) return "opcion_invalida";
  if (!busConocido) return "bus_desconocido";
  return null;
}

/** ¿Sigue vigente la aportación en el instante `ahora`? */
export function esVigente(aportacion: Aportacion, ahora: Date): boolean {
  const registro = Date.parse(aportacion.created_at);
  const edad = ahora.getTime() - registro;
  return Number.isFinite(registro) && edad >= 0 && edad < VIGENCIA_APORTACION_MS;
}

/** Aportaciones vigentes de `codBus`, conservando el orden de entrada. */
export function filtrarVigentes(
  aportaciones: readonly Aportacion[],
  codBus: CodBus,
  ahora: Date,
): Aportacion[] {
  return aportaciones.filter((a) => a.codBus === codBus && esVigente(a, ahora));
}

/** Instante de expiración (ISO-8601) de una aportación. */
export function expiraEn(aportacion: Aportacion): string {
  return new Date(
    Date.parse(aportacion.created_at) + VIGENCIA_APORTACION_MS,
  ).toISOString();
}

// ---------------------------------------------------------------------------
// Orquestación sobre el repositorio
// ---------------------------------------------------------------------------

export type ResultadoRegistro =
  | { ok: true; aportacion: Aportacion }
  | { ok: false; motivo: MotivoRechazo };

/**
 * Registra una aportación de `userId` sobre `codBus`. Si la opción no está en
 * el catálogo o el bus es desconocido, no persiste nada (9.4, 9.5).
 */
export async function registrarAportacion(
  repo: Pick<Repository, "existeBus" | "createAportacion">,
  userId: string,
  codBus: CodBus,
  opcion: unknown,
): Promise<ResultadoRegistro> {
  if (!esOpcionValida(opcion)) {
    return { ok: false, motivo: "opcion_invalida" };
  }
  const motivo = validarAportacion(opcion, await repo.existeBus(codBus));
  if (motivo !== null) {
    return { ok: false, motivo };
  }
  const aportacion = await repo.createAportacion({ userId, codBus, opcion });
  return { ok: true, aportacion };
}

/** Aportaciones vigentes del vehículo en el instante `ahora` (9.3, 9.6). */
export async function consultarAportaciones(
  repo: Pick<Repository, "listAportacionesVigentes">,
  codBus: CodBus,
  ahora: Date = new Date(),
): Promise<Aportacion[]> {
  return filtrarVigentes(await repo.listAportacionesVigentes(codBus), codBus, ahora);
}
