/**
 * Parseo y validación de los parámetros de consulta comunes a los endpoints de
 * lectura geográficos (`/api/buses`, `/api/paradas`, `/api/lineas`).
 *
 * Lógica pura (sin dependencias del framework): opera sobre `URLSearchParams` y
 * devuelve o bien los valores ya tipados para pasar al `Repository`, o bien un
 * `ApiError` canónico (`lib/apiErrors.ts`) cuando un parámetro está presente
 * pero es sintácticamente incorrecto (Requisito 11.8). Un parámetro ausente no
 * es un error en estos listados: simplemente no filtra / usa el valor por
 * defecto del repositorio.
 *
 * Convenciones de los parámetros (coherentes con la tabla de endpoints del
 * diseño y con el puerto `Repository`):
 *
 * - `codLinea`: identificador de línea (`route_id`, entero). Puede repetirse en
 *   el query string (`?codLinea=1&codLinea=7`) o darse como lista separada por
 *   comas (`?codLinea=1,7`) para filtrar por un conjunto de líneas.
 * - `sentido`: sentido de la línea (entero). Filtra solo buses.
 * - `limite`: tamaño de página solicitado. El repositorio lo recorta al rango
 *   `[1, 200]`; aquí solo se valida que, si está presente, sea un entero.
 * - `cursor`: cursor opaco de la página siguiente (el `next` de la página
 *   anterior). El repositorio lo interpreta; aquí se pasa tal cual.
 *
 * El objetivo es que los tres route handlers compartan exactamente el mismo
 * contrato de parsing y de errores, sin duplicar la validación en cada uno.
 */

import type { CodLinea, Sentido, Position } from "@/lib/types";
import type { Paginacion } from "@/lib/ports";
import {
  type ApiError,
  malformedRequest,
  validateRequiredParams,
} from "@/lib/apiErrors";

/** Nombres canónicos de los parámetros de consulta soportados. */
export const QUERY_PARAMS = {
  codLinea: "codLinea",
  sentido: "sentido",
  limite: "limite",
  cursor: "cursor",
  lat: "lat",
  lon: "lon",
} as const;

/** Parámetros de paginación ya parseados para pasar al `Repository`. */
export type PaginacionQuery = Paginacion;

/**
 * Parsea un entero estricto desde un string: solo dígitos opcionalmente con
 * signo, sin parte decimal ni texto sobrante. Devuelve `null` si no encaja, de
 * modo que el llamante distinga "ausente" (no se llama) de "presente pero
 * inválido" (`null`).
 */
function parseIntegerStrict(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Extrae el conjunto de `codLinea` del query string. Admite repetición del
 * parámetro y listas separadas por comas; une ambas formas. Devuelve:
 *
 * - `undefined` si el parámetro no aparece (sin filtro por línea).
 * - un `ApiError` de petición malformada si aparece pero algún valor no es un
 *   entero válido (Requisito 11.8).
 * - el array de `CodLinea` (sin vacíos) en caso válido.
 */
export function parseCodLineas(
  params: URLSearchParams,
): CodLinea[] | undefined | ApiError {
  const raw = params.getAll(QUERY_PARAMS.codLinea);
  if (raw.length === 0) {
    return undefined;
  }

  const codLineas: CodLinea[] = [];
  for (const entry of raw) {
    for (const token of entry.split(",")) {
      const trimmed = token.trim();
      if (trimmed === "") {
        // Tolera comas sobrantes (p. ej. "1,") sin tratarlas como error.
        continue;
      }
      const value = parseIntegerStrict(trimmed);
      if (value === null) {
        return malformedRequest(
          `El parámetro "codLinea" debe ser un entero; recibido: "${token}".`,
        );
      }
      codLineas.push(value);
    }
  }

  // Si tras el parseo no quedó ningún valor (p. ej. "?codLinea="), se considera
  // ausencia de filtro en lugar de un filtro vacío que no casaría con nada.
  return codLineas.length === 0 ? undefined : codLineas;
}

/**
 * Extrae el filtro por `sentido`. Devuelve `undefined` si no aparece, un
 * `ApiError` si aparece pero no es un entero, o el `Sentido` en caso válido.
 */
export function parseSentido(
  params: URLSearchParams,
): Sentido | undefined | ApiError {
  const raw = params.get(QUERY_PARAMS.sentido);
  if (raw === null || raw.trim() === "") {
    return undefined;
  }
  const value = parseIntegerStrict(raw);
  if (value === null) {
    return malformedRequest(
      `El parámetro "sentido" debe ser un entero; recibido: "${raw}".`,
    );
  }
  return value;
}

/**
 * Extrae un único `codLinea` opcional (para endpoints que filtran por una sola
 * línea, como `/api/paradas`). Devuelve `undefined` si no aparece, un
 * `ApiError` si no es entero, o el `CodLinea`. Si se indican varios valores,
 * usa el primero válido y trata un valor no entero como error.
 */
export function parseCodLineaUnica(
  params: URLSearchParams,
): CodLinea | undefined | ApiError {
  const resultado = parseCodLineas(params);
  if (resultado === undefined) {
    return undefined;
  }
  if (!Array.isArray(resultado)) {
    // Es un ApiError.
    return resultado;
  }
  return resultado[0];
}

/**
 * Extrae los parámetros de paginación (`limite`, `cursor`). Devuelve un
 * `ApiError` si `limite` está presente pero no es un entero; en otro caso, una
 * `Paginacion` lista para el `Repository` (que recorta `limite` a `[1, 200]` e
 * interpreta el cursor opaco). Ningún parámetro de paginación es obligatorio.
 */
export function parsePaginacion(
  params: URLSearchParams,
): PaginacionQuery | ApiError {
  const paginacion: PaginacionQuery = {};

  const rawLimite = params.get(QUERY_PARAMS.limite);
  if (rawLimite !== null && rawLimite.trim() !== "") {
    const value = parseIntegerStrict(rawLimite);
    if (value === null) {
      return malformedRequest(
        `El parámetro "limite" debe ser un entero; recibido: "${rawLimite}".`,
      );
    }
    paginacion.limite = value;
  }

  const rawCursor = params.get(QUERY_PARAMS.cursor);
  if (rawCursor !== null && rawCursor !== "") {
    paginacion.cursor = rawCursor;
  }

  return paginacion;
}

/**
 * Parsea un número de coma flotante estricto desde un string: acepta decimales
 * con punto y signo, rechaza texto sobrante, `NaN` e infinitos. Tolera la coma
 * decimal europea no se admite aquí a propósito: los query params de la API usan
 * el punto como separador decimal. Devuelve `null` si no encaja.
 */
function parseFloatStrict(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) {
    return null;
  }
  const value = Number.parseFloat(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Extrae la ubicación `[lon, lat]` obligatoria del query string para los
 * endpoints de proximidad (`/api/paradas/cercanas`). `lat` y `lon` son
 * obligatorios (Requisito 11.9) y deben ser números finitos con rangos
 * geográficos válidos (`lat ∈ [-90, 90]`, `lon ∈ [-180, 180]`); en otro caso se
 * devuelve el `ApiError` correspondiente (parámetros ausentes o malformados,
 * Requisitos 11.8, 11.9). Devuelve la `Position` canónica `[lon, lat]`.
 */
export function parseUbicacion(
  params: URLSearchParams,
): Position | ApiError {
  const faltan = validateRequiredParams(
    [QUERY_PARAMS.lat, QUERY_PARAMS.lon],
    {
      lat: params.get(QUERY_PARAMS.lat),
      lon: params.get(QUERY_PARAMS.lon),
    },
  );
  if (faltan !== null) {
    return faltan;
  }

  const lat = parseFloatStrict(params.get(QUERY_PARAMS.lat) as string);
  const lon = parseFloatStrict(params.get(QUERY_PARAMS.lon) as string);

  if (lat === null || lon === null) {
    return malformedRequest(
      'Los parámetros "lat" y "lon" deben ser números (p. ej. lat=36.72&lon=-4.42).',
    );
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return malformedRequest(
      'Los parámetros "lat" y "lon" están fuera de rango ' +
        "(lat ∈ [-90, 90], lon ∈ [-180, 180]).",
    );
  }

  return [lon, lat];
}

/** ¿El valor devuelto por una función de parsing es un `ApiError`? */
export function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "body" in value
  );
}
