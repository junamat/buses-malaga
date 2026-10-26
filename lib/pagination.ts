/**
 * Paginación por cursor como lógica pura de dominio (tarea 6.1).
 *
 * El puerto `Repository` ya expone sus listados paginados como `Pagina<T>`
 * (`{ items, next }`) y el adaptador Postgres los resuelve por offset. Este
 * módulo concentra el **contrato puro** de esa paginación, independiente de la
 * base de datos, para poder verificarlo con `fast-check`:
 *
 * - una página contiene como máximo {@link MAX_PAGE_SIZE} elementos
 *   (≤ 200, Requisito 11.3);
 * - el cursor `next` apunta de forma opaca a la página siguiente, y es `null`
 *   en la última;
 * - recorrer las páginas siguiendo el cursor desde el inicio reconstruye el
 *   conjunto completo **sin duplicados ni omisiones**, preservando el orden
 *   (Property 32).
 *
 * El cursor es la representación textual del offset de inicio de la página
 * siguiente, coherente con `parseOffsetCursor`/`buildPagina` del adaptador
 * Postgres: así la lógica pura y el SQL comparten exactamente la misma semántica
 * de cursor y las pruebas de la una valen como contrato de la otra.
 *
 * Es lógica pura, sin I/O: opera sobre un array ya materializado en memoria.
 */

import type { Pagina } from "@/lib/ports";

/** Tamaño máximo de página admitido por el contrato de la API (Requisito 11.3). */
export const MAX_PAGE_SIZE = 200;

/** Tamaño de página por defecto cuando no se solicita uno explícito. */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Normaliza el tamaño de página solicitado al rango válido `[1, MAX_PAGE_SIZE]`,
 * aplicando el valor por defecto cuando se omite o no es un entero positivo.
 * Comparte la semántica de `normalizeLimit` del adaptador Postgres para que el
 * recorte a ≤ 200 sea idéntico en la lógica pura y en el SQL.
 */
export function normalizarTamanoPagina(tamano?: number): number {
  if (tamano === undefined || !Number.isFinite(tamano) || tamano <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  const truncado = Math.max(1, Math.floor(tamano));
  return Math.min(truncado, MAX_PAGE_SIZE);
}

/**
 * Interpreta un cursor opaco como offset entero no negativo. Un cursor ausente
 * o no parseable se trata como el inicio (offset 0), igual que en el adaptador.
 */
export function parsearCursor(cursor?: string | null): number {
  if (cursor === undefined || cursor === null || cursor === "") {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Extrae de `conjunto` la página que empieza en `offset` con el `tamano` dado.
 *
 * Devuelve a lo sumo `tamano` elementos (recortado al rango válido) y el cursor
 * `next` al offset de la página siguiente, o `null` si esta página agota el
 * conjunto. Un `offset` fuera de rango produce una página vacía con `next: null`.
 */
export function paginar<T>(
  conjunto: readonly T[],
  offset: number = 0,
  tamano?: number,
): Pagina<T> {
  const limite = normalizarTamanoPagina(tamano);
  const inicio = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;

  const items = conjunto.slice(inicio, inicio + limite);
  const finPagina = inicio + items.length;
  const hayMas = finPagina < conjunto.length;

  return { items, next: hayMas ? String(finPagina) : null };
}

/**
 * Página a partir de un cursor opaco (el `next` de la página anterior). Es la
 * forma en que la API encadena peticiones: el cliente reenvía el `next` recibido
 * y recibe la página siguiente.
 */
export function paginarConCursor<T>(
  conjunto: readonly T[],
  cursor?: string | null,
  tamano?: number,
): Pagina<T> {
  return paginar(conjunto, parsearCursor(cursor), tamano);
}

/**
 * Recorre todas las páginas de `conjunto` siguiendo el cursor desde el inicio y
 * devuelve la lista de páginas en orden. Herramienta para verificar la Property
 * 32: la concatenación de `items` de todas las páginas reconstruye el conjunto
 * completo sin duplicados ni omisiones. Termina siempre: cada página no vacía
 * avanza el offset al menos en uno y la última tiene `next: null`.
 */
export function recorrerPaginas<T>(
  conjunto: readonly T[],
  tamano?: number,
): Pagina<T>[] {
  const paginas: Pagina<T>[] = [];
  let cursor: string | null = null;

  do {
    const pagina: Pagina<T> = paginarConCursor(conjunto, cursor, tamano);
    paginas.push(pagina);
    cursor = pagina.next;
  } while (cursor !== null);

  return paginas;
}

/**
 * Concatena los `items` de una secuencia de páginas en el orden en que se
 * recorrieron. Es el "reensamblado" que la Property 32 compara con el conjunto
 * original.
 */
export function concatenarPaginas<T>(paginas: readonly Pagina<T>[]): T[] {
  const items: T[] = [];
  for (const pagina of paginas) {
    items.push(...pagina.items);
  }
  return items;
}
