/**
 * Errores canónicos de la API_REST y validación de parámetros (lógica pura).
 *
 * Este módulo centraliza el contrato de errores transversal del diseño
 * (sección "Convenciones transversales de la API") para que todos los route
 * handlers respondan de forma coherente, en lugar de reconstruir el mismo
 * cuerpo `{ code, message }` en cada endpoint:
 *
 * - `404` cuando el recurso solicitado no existe (Requisito 11.7).
 * - `400` cuando la petición es sintácticamente incorrecta / malformada, con un
 *   cuerpo que indica que la petición es incorrecta (Requisito 11.8).
 * - `400` cuando faltan parámetros obligatorios, con un cuerpo que identifica
 *   cuáles son los parámetros obligatorios ausentes (Requisito 11.9).
 *
 * El cuerpo de error canónico es siempre `{ code, message }`. Cuando el error
 * es por parámetros ausentes, se incluye además `params` con la lista exacta de
 * nombres ausentes, de modo que un cliente pueda identificarlos sin parsear el
 * texto de `message` (Requisito 11.9).
 *
 * Decisiones de diseño:
 *
 * - **Lógica pura, sin dependencias del framework.** Este módulo no importa
 *   `next/server`: produce un modelo de error (`ApiError`) y un cuerpo
 *   serializable (`ApiErrorBody`). La conversión a `Response`/`NextResponse` se
 *   deja al borde HTTP (`toResponse`), que solo usa la `Response` estándar del
 *   runtime. Así la construcción y la validación de errores son verificables
 *   con property-based testing sin montar un servidor (Properties 35–37).
 * - **El error es un valor, no una excepción obligatoria.** Las constructoras
 *   (`notFound`, `malformedRequest`, `missingParams`) devuelven un `ApiError`.
 *   Un handler puede devolver `toResponse(error)` directamente o, si prefiere
 *   un flujo basado en excepciones, lanzar `new ApiErrorException(error)` y
 *   capturarla en un punto común.
 * - **Validación de obligatorios desacoplada.** `validateRequiredParams`
 *   inspecciona un conjunto de parámetros y devuelve, cuando procede, el
 *   `ApiError` de parámetros ausentes; no decide cómo responde el handler.
 */

// ---------------------------------------------------------------------------
// Códigos canónicos de error
// ---------------------------------------------------------------------------

/**
 * Códigos de error canónicos de la API. `code` es estable y legible por
 * máquina; `message` es el texto legible por humanos que puede variar.
 */
export const API_ERROR_CODES = {
  /** Recurso inexistente (Requisito 11.7). HTTP 404. */
  notFound: "no_encontrado",
  /** Petición sintácticamente incorrecta / malformada (Requisito 11.8). HTTP 400. */
  malformedRequest: "peticion_malformada",
  /** Faltan parámetros obligatorios (Requisito 11.9). HTTP 400. */
  missingParams: "parametros_obligatorios_ausentes",
} as const;

/** Unión de los códigos de error canónicos. */
export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

// ---------------------------------------------------------------------------
// Modelo de error y cuerpo serializable
// ---------------------------------------------------------------------------

/**
 * Cuerpo de error canónico que la API serializa como JSON. Siempre incluye
 * `code` y `message`; para el caso de parámetros ausentes incluye además
 * `params` con la lista de nombres obligatorios que faltan (Requisito 11.9).
 */
export interface ApiErrorBody {
  /** Código estable y legible por máquina. */
  code: ApiErrorCode;
  /** Mensaje legible por humanos. */
  message: string;
  /**
   * Nombres de los parámetros obligatorios ausentes. Presente solo en el error
   * de parámetros ausentes; nunca vacío cuando está presente.
   */
  params?: string[];
}

/**
 * Error canónico de la API como value object inmutable: el estado HTTP y el
 * cuerpo `{ code, message, params? }`. No es una excepción; es un valor que el
 * handler decide cómo devolver.
 */
export interface ApiError {
  /** Estado HTTP asociado (404 o 400). */
  readonly status: number;
  /** Cuerpo serializable de la respuesta de error. */
  readonly body: ApiErrorBody;
}

/**
 * Envoltura de excepción para los flujos que prefieren `throw`/`catch` en lugar
 * de devolver el `ApiError`. Transporta el `ApiError` intacto para que un punto
 * común lo convierta en respuesta con `toResponse`.
 */
export class ApiErrorException extends Error {
  readonly apiError: ApiError;

  constructor(apiError: ApiError) {
    super(apiError.body.message);
    this.name = "ApiErrorException";
    this.apiError = apiError;
  }
}

// ---------------------------------------------------------------------------
// Constructoras de errores canónicos
// ---------------------------------------------------------------------------

/** Mensaje por defecto de recurso inexistente. */
const DEFAULT_NOT_FOUND_MESSAGE = "El recurso solicitado no se ha encontrado.";

/** Mensaje por defecto de petición malformada. */
const DEFAULT_MALFORMED_MESSAGE = "La petición es incorrecta.";

/**
 * Construye el error canónico de recurso inexistente (HTTP 404, Requisito
 * 11.7).
 *
 * @param message Mensaje legible opcional; por defecto uno genérico que no
 *   revela detalles internos.
 */
export function notFound(message: string = DEFAULT_NOT_FOUND_MESSAGE): ApiError {
  return {
    status: 404,
    body: { code: API_ERROR_CODES.notFound, message },
  };
}

/**
 * Construye el error canónico de petición malformada (HTTP 400, Requisito
 * 11.8): la petición es sintácticamente incorrecta.
 *
 * @param message Mensaje legible opcional que explica por qué la petición es
 *   incorrecta; por defecto uno genérico.
 */
export function malformedRequest(
  message: string = DEFAULT_MALFORMED_MESSAGE,
): ApiError {
  return {
    status: 400,
    body: { code: API_ERROR_CODES.malformedRequest, message },
  };
}

/**
 * Construye el error canónico de parámetros obligatorios ausentes (HTTP 400,
 * Requisito 11.9). El cuerpo identifica los nombres ausentes tanto en `params`
 * (legible por máquina) como en `message` (legible por humanos).
 *
 * @param params Nombres de los parámetros obligatorios que faltan. Debe ser no
 *   vacío; en otro caso se lanza un error de programación (no es un error de
 *   cliente).
 */
export function missingParams(params: readonly string[]): ApiError {
  if (params.length === 0) {
    throw new Error(
      "missingParams requiere al menos un parámetro ausente; " +
        "una lista vacía indica que no falta ningún parámetro.",
    );
  }
  // Copia defensiva para no exponer el array del llamante y para que el cuerpo
  // sea inmutable respecto a mutaciones externas posteriores.
  const ausentes = [...params];
  const message = `Faltan parámetros obligatorios: ${ausentes.join(", ")}.`;
  return {
    status: 400,
    body: {
      code: API_ERROR_CODES.missingParams,
      message,
      params: ausentes,
    },
  };
}

// ---------------------------------------------------------------------------
// Validación de parámetros obligatorios
// ---------------------------------------------------------------------------

/**
 * Conjunto de parámetros recibidos por un endpoint, indexados por nombre. Un
 * valor `null`/`undefined`, o una cadena vacía o solo con espacios, se
 * considera **ausente**: así se tratan por igual el parámetro omitido y el
 * presente pero sin valor útil (p. ej. `?codParada=` en un query string).
 *
 * `URLSearchParams.get` devuelve `null` cuando falta y `""` cuando está vacío;
 * ambos encajan en este contrato sin conversión adicional.
 */
export type ParamBag = Record<string, string | null | undefined>;

/**
 * ¿El valor de un parámetro cuenta como ausente? Ausente ⇔ `null`/`undefined` o
 * cadena en blanco tras recortar espacios.
 */
function isMissing(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

/**
 * Calcula, en orden, los nombres de los parámetros obligatorios que faltan en
 * `provided`. Función pura y determinista: respeta el orden de `required` y no
 * produce duplicados si `required` no los tiene.
 *
 * @param required Nombres de los parámetros obligatorios, en el orden en que se
 *   quieren reportar.
 * @param provided Parámetros recibidos (p. ej. de `URLSearchParams` o de la
 *   ruta). Un valor ausente o en blanco cuenta como que falta.
 * @returns Lista de nombres ausentes (posiblemente vacía).
 */
export function findMissingParams(
  required: readonly string[],
  provided: ParamBag,
): string[] {
  return required.filter((name) => isMissing(provided[name]));
}

/**
 * Valida la presencia de los parámetros obligatorios y devuelve el `ApiError`
 * canónico de parámetros ausentes (Requisito 11.9) si falta alguno, o `null` si
 * están todos presentes.
 *
 * Patrón de uso en un handler:
 *
 * ```ts
 * const error = validateRequiredParams(["lat", "lon"], {
 *   lat: searchParams.get("lat"),
 *   lon: searchParams.get("lon"),
 * });
 * if (error) return toResponse(error);
 * ```
 *
 * @param required Nombres de los parámetros obligatorios.
 * @param provided Parámetros recibidos.
 * @returns `ApiError` con la lista de ausentes, o `null` si no falta ninguno.
 */
export function validateRequiredParams(
  required: readonly string[],
  provided: ParamBag,
): ApiError | null {
  const ausentes = findMissingParams(required, provided);
  return ausentes.length === 0 ? null : missingParams(ausentes);
}

// ---------------------------------------------------------------------------
// Conversión al borde HTTP
// ---------------------------------------------------------------------------

/**
 * Convierte un `ApiError` en una `Response` JSON estándar del runtime con el
 * estado y el cuerpo canónicos. No depende de `next/server`: `NextResponse`
 * extiende la `Response` del runtime, por lo que los route handlers pueden
 * devolver directamente el resultado de esta función.
 */
export function toResponse(error: ApiError): Response {
  return new Response(JSON.stringify(error.body), {
    status: error.status,
    headers: { "content-type": "application/json" },
  });
}
