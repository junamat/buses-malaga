/**
 * Servicio_Favoritos: lógica pura de favoritos + orquestación sobre el
 * repositorio (tarea 13.1).
 *
 * La decisión de cada operación vive en funciones puras sobre el conjunto de
 * favoritos del usuario ya materializado, verificables con `fast-check`
 * (Properties 20–25):
 *
 * - **Alta** (`altaFavorito`): rechaza si el elemento referenciado no existe
 *   (8.4); si ya figura en el conjunto devuelve el existente sin duplicar
 *   (idempotencia, 8.9); rechaza si el usuario ya tiene 500 (8.10); en otro
 *   caso lo añade conservando el resto (8.1–8.3).
 * - **Consulta** (`consultarFavoritos`): devuelve el conjunto del usuario,
 *   posiblemente vacío, hasta 500 (8.5, 8.6).
 * - **Baja** (`bajaFavorito`): elimina el favorito conservando el resto (8.7);
 *   si no figura en el conjunto, rechaza sin cambios (8.8).
 *
 * El orden de las comprobaciones del alta es deliberado: un duplicado de un
 * favorito ya existente se acepta aunque el usuario esté en el límite, porque
 * no crea ningún registro nuevo.
 *
 * Las funciones `crearFavorito`/`listarFavoritos`/`eliminarFavorito` aplican esa
 * misma lógica contra el puerto `Repository` (existencia de Parada/Linea,
 * conjunto actual y persistencia). La unicidad la refuerza además la
 * restricción `favorites_unicidad` de la base de datos.
 */

import type { Repository } from "@/lib/ports";
import type { CodLinea, CodParada, Favorito, TipoFavorito } from "@/lib/types";

/** Máximo de favoritos por usuario (Requisitos 8.5, 8.10). */
export const LIMITE_FAVORITOS = 500;

export const TIPOS_FAVORITO: readonly TipoFavorito[] = [
  "parada",
  "linea",
  "parada_linea",
];

/** Elemento referenciado por un favorito, sin identidad ni dueño. */
export interface ReferenciaFavorito {
  tipo: TipoFavorito;
  codParada?: CodParada;
  codLinea?: CodLinea;
}

// ---------------------------------------------------------------------------
// Validación de la entrada
// ---------------------------------------------------------------------------

export type ResultadoValidacion =
  | { ok: true; referencia: ReferenciaFavorito }
  /** Faltan campos obligatorios (Requisito 11.9). */
  | { ok: false; ausentes: string[] }
  /** Cuerpo malformado (Requisito 11.8). */
  | { ok: false; message: string };

/**
 * Valida el cuerpo de `POST /api/favoritos`: `tipo` y los códigos que exige ese
 * tipo (`codParada` para `parada`, `codLinea` para `linea`, ambos para
 * `parada_linea`). Los códigos que no corresponden al tipo se ignoran, de modo
 * que la referencia resultante es canónica.
 */
export function validarReferencia(input: unknown): ResultadoValidacion {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, message: "El cuerpo debe ser un objeto JSON." };
  }
  const datos = input as Record<string, unknown>;

  if (datos.tipo === undefined || datos.tipo === null || datos.tipo === "") {
    return { ok: false, ausentes: ["tipo"] };
  }
  if (!TIPOS_FAVORITO.includes(datos.tipo as TipoFavorito)) {
    return {
      ok: false,
      message: `"tipo" debe ser uno de: ${TIPOS_FAVORITO.join(", ")}.`,
    };
  }
  const tipo = datos.tipo as TipoFavorito;
  const necesitaParada = tipo === "parada" || tipo === "parada_linea";
  const necesitaLinea = tipo === "linea" || tipo === "parada_linea";

  const ausentes: string[] = [];
  if (necesitaParada && isBlank(datos.codParada)) ausentes.push("codParada");
  if (necesitaLinea && isBlank(datos.codLinea)) ausentes.push("codLinea");
  if (ausentes.length > 0) {
    return { ok: false, ausentes };
  }

  const referencia: ReferenciaFavorito = { tipo };
  if (necesitaParada) {
    if (typeof datos.codParada !== "string" && typeof datos.codParada !== "number") {
      return { ok: false, message: '"codParada" debe ser un texto.' };
    }
    referencia.codParada = String(datos.codParada).trim();
  }
  if (necesitaLinea) {
    const codLinea = Number(datos.codLinea);
    if (!Number.isSafeInteger(codLinea) || typeof datos.codLinea === "boolean") {
      return { ok: false, message: '"codLinea" debe ser un número entero.' };
    }
    referencia.codLinea = codLinea;
  }
  return { ok: true, referencia };
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  );
}

// ---------------------------------------------------------------------------
// Lógica pura sobre el conjunto
// ---------------------------------------------------------------------------

/** ¿Referencia `favorito` el mismo elemento que `ref`? */
export function mismoElemento(
  favorito: ReferenciaFavorito,
  ref: ReferenciaFavorito,
): boolean {
  return (
    favorito.tipo === ref.tipo &&
    favorito.codParada === ref.codParada &&
    favorito.codLinea === ref.codLinea
  );
}

export type ResultadoAlta =
  | { ok: true; conjunto: Favorito[]; favorito: Favorito; creado: boolean }
  | {
      ok: false;
      motivo: "elemento_inexistente" | "limite_alcanzado";
      conjunto: Favorito[];
    };

/**
 * Decide el alta de `ref` sobre el `conjunto` actual del usuario.
 *
 * @param existe Si el elemento referenciado existe en el sistema.
 * @param nuevoId Generador del `id` del favorito si llega a crearse.
 */
export function altaFavorito(
  conjunto: readonly Favorito[],
  userId: string,
  ref: ReferenciaFavorito,
  existe: boolean,
  nuevoId: () => string,
): ResultadoAlta {
  if (!existe) {
    return { ok: false, motivo: "elemento_inexistente", conjunto: [...conjunto] };
  }
  const existente = conjunto.find((f) => mismoElemento(f, ref));
  if (existente !== undefined) {
    return { ok: true, conjunto: [...conjunto], favorito: existente, creado: false };
  }
  if (conjunto.length >= LIMITE_FAVORITOS) {
    return { ok: false, motivo: "limite_alcanzado", conjunto: [...conjunto] };
  }
  const favorito: Favorito = { id: nuevoId(), userId, ...ref };
  return { ok: true, conjunto: [...conjunto, favorito], favorito, creado: true };
}

export type ResultadoBaja =
  | { ok: true; conjunto: Favorito[]; eliminado: Favorito }
  | { ok: false; motivo: "favorito_inexistente"; conjunto: Favorito[] };

/** Decide la baja del favorito `id` sobre el `conjunto` actual del usuario. */
export function bajaFavorito(
  conjunto: readonly Favorito[],
  id: string,
): ResultadoBaja {
  const eliminado = conjunto.find((f) => f.id === id);
  if (eliminado === undefined) {
    return { ok: false, motivo: "favorito_inexistente", conjunto: [...conjunto] };
  }
  return { ok: true, conjunto: conjunto.filter((f) => f.id !== id), eliminado };
}

/**
 * Favoritos de `userId` dentro de `todos` (que puede mezclar usuarios), en el
 * orden dado y hasta {@link LIMITE_FAVORITOS}. Vacío si no tiene ninguno.
 */
export function consultarFavoritos(
  todos: readonly Favorito[],
  userId: string,
): Favorito[] {
  return todos.filter((f) => f.userId === userId).slice(0, LIMITE_FAVORITOS);
}

// ---------------------------------------------------------------------------
// Orquestación sobre el repositorio
// ---------------------------------------------------------------------------

/** ¿Existe en el sistema el elemento que referencia `ref`? (Requisito 8.4) */
export async function existeElemento(
  repo: Pick<Repository, "findParada" | "existeLinea">,
  ref: ReferenciaFavorito,
): Promise<boolean> {
  const paradaOk =
    ref.codParada === undefined || (await repo.findParada(ref.codParada)) !== null;
  if (!paradaOk) return false;
  return ref.codLinea === undefined || repo.existeLinea(ref.codLinea);
}

export async function listarFavoritos(
  repo: Pick<Repository, "listFavoritos">,
  userId: string,
): Promise<Favorito[]> {
  return consultarFavoritos(await repo.listFavoritos(userId), userId);
}

/**
 * Alta de un favorito: valida existencia, unicidad y límite con
 * {@link altaFavorito} y solo persiste cuando la decisión es crear uno nuevo.
 */
export async function crearFavorito(
  repo: Pick<Repository, "findParada" | "existeLinea" | "listFavoritos" | "createFavorito">,
  userId: string,
  ref: ReferenciaFavorito,
): Promise<ResultadoAlta> {
  const existe = await existeElemento(repo, ref);
  const conjunto = existe ? await repo.listFavoritos(userId) : [];
  const decision = altaFavorito(conjunto, userId, ref, existe, () => "");
  if (!decision.ok || !decision.creado) {
    return decision;
  }
  const favorito = await repo.createFavorito({ userId, ...ref });
  return {
    ok: true,
    favorito,
    creado: true,
    conjunto: [...conjunto, favorito],
  };
}

/**
 * Baja de un favorito del usuario. `ok: false` si no figuraba en su conjunto;
 * en ese caso no se ha modificado nada (Requisito 8.8).
 */
export async function eliminarFavorito(
  repo: Pick<Repository, "deleteFavorito">,
  userId: string,
  id: string,
): Promise<{ ok: boolean }> {
  return { ok: await repo.deleteFavorito(userId, id) };
}
