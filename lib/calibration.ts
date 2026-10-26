/**
 * Parser de minutos oficiales de llegada (tarea 8.1).
 *
 * El Servicio_Calibracion muestrea la página `informacionParada.html` de la EMT,
 * que publica los minutos estimados de llegada por línea en nodos del tipo
 * `<span class="minutosN">N min.</span>`. Este módulo concentra la **lógica pura
 * de parseo y filtrado** de ese HTML, sin I/O: el scraping (recuperar la página)
 * y la persistencia en `official_minutes` los hace el ciclo de calibración
 * (tarea 8.2), que invoca estas funciones.
 *
 * Reglas de validación (Requisitos 5.1, 5.2):
 *
 * - Se extrae un valor entero de minutos por cada `<span class="minutosN">`.
 * - Se descartan los valores fuera del rango `[0, 120]` minutos. En particular,
 *   la fuente emplea el centinela `785` para "sin estimación / no disponible";
 *   ese valor cae fuera de rango y se descarta como cualquier otro fuera de
 *   `[0, 120]`.
 * - Los descartes se **devuelven por separado** (no se pierden) para que el
 *   ciclo de calibración pueda registrarlos, igual que `lib/normalize.ts`
 *   devuelve las filas descartadas de la ingesta (Property 15).
 *
 * Estos minutos oficiales son solo para calibración offline y **nunca** forman
 * parte de las respuestas de producción (Requisito 5.4, Property 16): el
 * estimador de producción vive en `lib/eta.ts` y en el map-matching PostGIS.
 */

/** Mínimo de minutos oficiales admitido (inclusive). */
export const MIN_MINUTOS_OFICIALES = 0;

/** Máximo de minutos oficiales admitido (inclusive). */
export const MAX_MINUTOS_OFICIALES = 120;

/**
 * Centinela que la fuente usa para "sin estimación disponible". No tiene un
 * tratamiento especial: cae fuera de `[0, 120]` y se descarta por rango, pero
 * se documenta por ser el caso más frecuente a filtrar.
 */
export const CENTINELA_SIN_ESTIMACION = 785;

/**
 * Minuto oficial válido extraído del HTML, listo para almacenar en
 * `official_minutes` asociado a una parada/línea por el ciclo de calibración.
 */
export interface MinutoOficial {
  /** Índice de ocurrencia dentro de la página (orden de aparición, base 0). */
  indice: number;
  /** Minutos estimados, garantizados en el rango `[0, 120]`. */
  minutos: number;
}

/** Valor descartado durante el parseo, con el motivo para su registro. */
export interface MinutoDescartado {
  /** Índice de ocurrencia dentro de la página (orden de aparición, base 0). */
  indice: number;
  /** Texto crudo del que se extrajo el valor (para diagnóstico). */
  crudo: string;
  /** Valor numérico parseado, si se pudo extraer alguno. */
  valor?: number;
  /** Motivo del descarte. */
  motivo: "fuera_de_rango" | "no_numerico";
}

/** Resultado del parseo: los valores válidos y los descartados por separado. */
export interface ResultadoParseoOficiales {
  validos: MinutoOficial[];
  descartados: MinutoDescartado[];
}

/**
 * Expresión que captura cada `<span class="minutosN">…</span>`. Es tolerante a:
 *
 * - comillas simples o dobles en el atributo `class`;
 * - clases adicionales junto a `minutosN` (p. ej. `class="dato minutos1"`);
 * - mayúsculas/minúsculas y espacios alrededor de los atributos.
 *
 * El contenido del span se captura entero y el número se extrae después, de modo
 * que formatos como `"5 min."`, `"5&nbsp;min."` o `"5"` se traten por igual.
 */
const SPAN_MINUTOS =
  /<span\b[^>]*\bclass\s*=\s*["'][^"']*\bminutos\d+\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;

/** Extrae el primer entero presente en un fragmento de texto, o `null`. */
function extraerEntero(texto: string): number | null {
  const sinEtiquetas = texto.replace(/<[^>]*>/g, " ");
  const match = sinEtiquetas.match(/-?\d+/);
  if (match === null) {
    return null;
  }
  const valor = Number.parseInt(match[0], 10);
  return Number.isFinite(valor) ? valor : null;
}

/** ¿El valor cae dentro del rango admitido `[0, 120]`? */
export function esMinutoValido(valor: number): boolean {
  return (
    Number.isInteger(valor) &&
    valor >= MIN_MINUTOS_OFICIALES &&
    valor <= MAX_MINUTOS_OFICIALES
  );
}

/**
 * Parsea el HTML de `informacionParada.html` extrayendo los minutos oficiales de
 * cada `<span class="minutosN">`, separando los válidos (`[0, 120]`) de los
 * descartados (fuera de rango o no numéricos) para su registro (Requisitos 5.1,
 * 5.2; Property 15).
 *
 * @param html Cuerpo HTML de la página de información de parada.
 * @returns Los minutos válidos y los descartados, en orden de aparición.
 */
export function parsearMinutosOficiales(html: string): ResultadoParseoOficiales {
  const validos: MinutoOficial[] = [];
  const descartados: MinutoDescartado[] = [];

  let indice = 0;
  // `matchAll` evita el estado mutable de `lastIndex` del regex global.
  for (const match of html.matchAll(SPAN_MINUTOS)) {
    const crudo = match[1] ?? "";
    const valor = extraerEntero(crudo);

    if (valor === null) {
      descartados.push({ indice, crudo, motivo: "no_numerico" });
    } else if (!esMinutoValido(valor)) {
      descartados.push({ indice, crudo, valor, motivo: "fuera_de_rango" });
    } else {
      validos.push({ indice, minutos: valor });
    }

    indice += 1;
  }

  return { validos, descartados };
}
