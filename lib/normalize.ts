/**
 * Normalización de coordenadas y parsing de fuentes de origen.
 *
 * Lógica pura (sin I/O) que vive en el borde de entrada de la ingesta. Opera
 * sobre strings y filas ya leídas de la fuente (el CSV de posiciones de la EMT,
 * `lineasyubicaciones.csv`) y las convierte al modelo interno `PosicionCaptura`.
 *
 * Responsabilidades:
 *
 * - Convertir un par de coordenadas en string a numérico, respetando la
 *   convención del sistema: siempre numéricas y en orden `[lon, lat]`
 *   (Requisito 12.3).
 * - Parsear una fila del CSV a `PosicionCaptura`.
 * - Descartar filas malformadas, devolviéndolas por separado para que el
 *   llamador pueda registrarlas (p. ej. en `ingest_log`) sin interrumpir la
 *   ingesta de las filas válidas.
 *
 * Esta capa no realiza ninguna operación de red ni de base de datos: recibe el
 * contenido ya recuperado por el adaptador de `IngestScheduler` y devuelve el
 * resultado normalizado para que el repositorio lo persista.
 */

import type {
  CodBus,
  CodLinea,
  CodParada,
  PosicionCaptura,
  Position,
  Sentido,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Normalización de coordenadas
// ---------------------------------------------------------------------------

/**
 * Convierte un par de coordenadas en string a numérico en orden `[lon, lat]`.
 *
 * Acepta la longitud y la latitud por separado tal como llegan de la fuente
 * (strings) y devuelve la `Position` canónica del sistema. Tolera espacios en
 * blanco alrededor del valor y la coma decimal europea (`"36,72"`), que se
 * normaliza a punto antes de la conversión.
 *
 * Devuelve `null` si cualquiera de los dos valores no es un número finito, de
 * modo que el llamador pueda tratar la fila como malformada.
 *
 * @param lon Longitud de origen, en string.
 * @param lat Latitud de origen, en string.
 * @returns La coordenada numérica `[lon, lat]`, o `null` si es inválida.
 */
export function parseCoordinates(
  lon: string,
  lat: string,
): Position | null {
  const lonNum = parseNumeric(lon);
  const latNum = parseNumeric(lat);

  if (lonNum === null || latNum === null) {
    return null;
  }

  return [lonNum, latNum];
}

/**
 * Convierte un valor numérico de origen (string) a `number`.
 *
 * Normaliza la coma decimal europea a punto y recorta espacios. Devuelve `null`
 * para strings vacíos, no numéricos o que no representen un número finito
 * (`NaN`, `Infinity`).
 */
function parseNumeric(value: string): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }

  const normalized = trimmed.replace(",", ".");
  const num = Number(normalized);

  return Number.isFinite(num) ? num : null;
}

/**
 * Convierte un valor entero de origen (string) a `number` entero.
 *
 * Reutiliza `parseNumeric` y exige además que el resultado sea un entero. Se usa
 * para `codBus`, `codLinea` y `sentido`, que son enteros en el origen GTFS.
 */
function parseInteger(value: string): number | null {
  const num = parseNumeric(value);
  if (num === null || !Number.isInteger(num)) {
    return null;
  }
  return num;
}

// ---------------------------------------------------------------------------
// Parsing del CSV de posiciones (`lineasyubicaciones.csv`)
// ---------------------------------------------------------------------------

/**
 * Fila cruda del CSV `lineasyubicaciones.csv`, con todos los campos como string
 * tal como se leen de la fuente. Los campos `codParIni` y `last_update` pueden
 * faltar según la fila.
 */
export interface FilaPosicionCruda {
  codBus: string;
  codLinea: string;
  sentido: string;
  lon: string;
  lat: string;
  codParIni?: string;
  last_update?: string;
}

/**
 * Columnas del CSV `lineasyubicaciones.csv`, en el orden en que aparecen en la
 * fuente. Permite mapear un array de campos crudos a `FilaPosicionCruda`.
 */
export const COLUMNAS_CSV_POSICIONES = [
  "codBus",
  "codLinea",
  "sentido",
  "lon",
  "lat",
  "codParIni",
  "last_update",
] as const;

/**
 * Motivo por el que una fila se considera malformada y se descarta.
 */
export type MotivoDescarte =
  | "campos_insuficientes"
  | "codBus_invalido"
  | "codLinea_invalido"
  | "sentido_invalido"
  | "coordenadas_invalidas"
  | "last_update_invalido";

/**
 * Fila descartada durante el parsing, junto con el motivo del descarte. Se
 * devuelve por separado para que el llamador pueda registrarla sin detener la
 * ingesta de las filas válidas.
 */
export interface FilaDescartada {
  /** La fila de origen tal como se recibió (array de campos o fila cruda). */
  fila: FilaPosicionCruda | readonly string[];
  motivo: MotivoDescarte;
}

/**
 * Resultado del parsing de un conjunto de filas: las `PosicionCaptura` válidas
 * y, por separado, las filas descartadas con su motivo.
 */
export interface ResultadoParseo {
  validas: PosicionCaptura[];
  descartadas: FilaDescartada[];
}

/**
 * Parsea una única fila cruda del CSV a `PosicionCaptura`.
 *
 * Valida y convierte los campos obligatorios (`codBus`, `codLinea`, `sentido`
 * como enteros; `lon`/`lat` como numéricos en orden `[lon, lat]`; `last_update`
 * como fecha válida, convertida de hora local de Madrid a ISO UTC). El campo
 * opcional `codParIni` se incluye solo si está presente y no vacío. El
 * `captured_at` (instante de ingesta) no proviene de la fuente y lo aporta el
 * llamador.
 *
 * Devuelve un resultado discriminado por `ok`: si la fila es válida, incluye la
 * `PosicionCaptura`; si es malformada, incluye el motivo del descarte.
 *
 * @param fila Campos crudos de la fila (todos como string).
 * @param capturedAt Instante de ingesta a asignar a la captura.
 */
export function parsearFilaPosicion(
  fila: FilaPosicionCruda,
  capturedAt: string,
):
  | { ok: true; posicion: PosicionCaptura }
  | { ok: false; motivo: MotivoDescarte } {
  const codBus = parseInteger(fila.codBus);
  if (codBus === null) {
    return { ok: false, motivo: "codBus_invalido" };
  }

  const codLinea = parseInteger(fila.codLinea);
  if (codLinea === null) {
    return { ok: false, motivo: "codLinea_invalido" };
  }

  const sentido = parseInteger(fila.sentido);
  if (sentido === null) {
    return { ok: false, motivo: "sentido_invalido" };
  }

  const coords = parseCoordinates(fila.lon, fila.lat);
  if (coords === null) {
    return { ok: false, motivo: "coordenadas_invalidas" };
  }

  const [lon, lat] = coords;

  // `last_update` es obligatorio: ordena las capturas por vehículo y alimenta la
  // inferencia de velocidad. Una marca ausente o no interpretable descarta la
  // fila (antes se insertaba "" y hacía fallar el INSERT del lote completo).
  const lastUpdate = parseLastUpdate(fila.last_update);
  if (lastUpdate === null) {
    return { ok: false, motivo: "last_update_invalido" };
  }

  const posicion: PosicionCaptura = {
    codBus: codBus as CodBus,
    codLinea: codLinea as CodLinea,
    sentido: sentido as Sentido,
    lon,
    lat,
    last_update: lastUpdate,
    captured_at: capturedAt,
  };

  const codParIni = normalizarOpcional(fila.codParIni);
  if (codParIni !== undefined) {
    posicion.codParIni = codParIni as CodParada;
  }

  return { ok: true, posicion };
}

/**
 * Convierte un array de campos crudos (p. ej. el resultado de partir una línea
 * del CSV por el separador) a `FilaPosicionCruda`, usando el orden de columnas
 * de `COLUMNAS_CSV_POSICIONES`.
 *
 * Devuelve `null` si la fila no tiene suficientes campos para los cinco
 * obligatorios (`codBus`, `codLinea`, `sentido`, `lon`, `lat`).
 */
export function filaDesdeCampos(
  campos: readonly string[],
): FilaPosicionCruda | null {
  // Los cinco primeros campos son obligatorios; codParIni y last_update no.
  if (campos.length < 5) {
    return null;
  }

  return {
    codBus: campos[0],
    codLinea: campos[1],
    sentido: campos[2],
    lon: campos[3],
    lat: campos[4],
    codParIni: campos[5],
    last_update: campos[6],
  };
}

/**
 * Parsea un conjunto de filas crudas del CSV a `PosicionCaptura`, separando las
 * válidas de las descartadas.
 *
 * Acepta tanto filas ya mapeadas (`FilaPosicionCruda`) como arrays de campos
 * crudos (`readonly string[]`), que se mapean internamente según el orden de
 * `COLUMNAS_CSV_POSICIONES`. Nunca lanza por una fila malformada: la recoge en
 * `descartadas` y continúa.
 *
 * @param filas Filas de origen (mapeadas o como arrays de campos).
 * @param capturedAt Instante de ingesta a asignar a todas las capturas.
 */
export function parsearPosiciones(
  filas: Iterable<FilaPosicionCruda | readonly string[]>,
  capturedAt: string,
): ResultadoParseo {
  const validas: PosicionCaptura[] = [];
  const descartadas: FilaDescartada[] = [];

  for (const entrada of filas) {
    const fila = Array.isArray(entrada)
      ? filaDesdeCampos(entrada)
      : (entrada as FilaPosicionCruda);

    if (fila === null) {
      descartadas.push({ fila: entrada, motivo: "campos_insuficientes" });
      continue;
    }

    const resultado = parsearFilaPosicion(fila, capturedAt);
    if (resultado.ok) {
      validas.push(resultado.posicion);
    } else {
      descartadas.push({ fila, motivo: resultado.motivo });
    }
  }

  return { validas, descartadas };
}

// ---------------------------------------------------------------------------
// Marca temporal `last_update` (hora local de Madrid sin offset)
// ---------------------------------------------------------------------------

/**
 * Zona horaria de la fuente. El CSV de la EMT publica `last_update` como hora
 * civil local (`"2026-10-25 15:45:09"`) sin offset; interpretarla como UTC la
 * desplaza 1–2 h según el horario de verano.
 */
export const ZONA_HORARIA_FUENTE = "Europe/Madrid";

const FORMATO_LOCAL =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/** ¿El texto lleva zona explícita (`Z` o `±hh:mm`)? */
const CON_ZONA = /(?:Z|[+-]\d{2}:?\d{2})$/i;

const formateadorMadrid = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONA_HORARIA_FUENTE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Offset (ms) de `ZONA_HORARIA_FUENTE` respecto a UTC en el instante dado. */
function offsetMadridMs(epochMs: number): number {
  const partes: Record<string, number> = {};
  for (const p of formateadorMadrid.formatToParts(new Date(epochMs))) {
    if (p.type !== "literal") {
      partes[p.type] = Number(p.value);
    }
  }
  const comoUtc = Date.UTC(
    partes.year,
    partes.month - 1,
    partes.day,
    partes.hour,
    partes.minute,
    partes.second,
  );
  return comoUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Convierte el `last_update` de la fuente a ISO-8601 UTC.
 *
 * - Sin zona explícita (formato real de la EMT): se interpreta como hora civil
 *   de `Europe/Madrid`. En la hora ambigua del cambio de horario de otoño se
 *   elige la primera ocurrencia (horario de verano).
 * - Con zona explícita (`Z`/offset): se respeta tal cual.
 *
 * Devuelve `null` si el valor falta o no es una fecha válida.
 */
export function parseLastUpdate(value: string | undefined): string | null {
  const texto = normalizarOpcional(value);
  if (texto === undefined) {
    return null;
  }

  if (CON_ZONA.test(texto)) {
    const ms = Date.parse(texto);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }

  const m = FORMATO_LOCAL.exec(texto);
  if (m === null) {
    return null;
  }
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  const hora = Number(m[4]);
  const minuto = Number(m[5]);
  const segundo = Number(m[6] ?? "0");
  const milis = Number((m[7] ?? "0").padEnd(3, "0"));
  const pared = Date.UTC(anio, mes - 1, dia, hora, minuto, segundo, milis);
  // Date.UTC desborda valores fuera de rango (mes 13 → enero siguiente); se
  // exige que la fecha reconstruida coincida campo a campo.
  const control = new Date(pared);
  if (
    Number.isNaN(pared) ||
    control.getUTCFullYear() !== anio ||
    control.getUTCMonth() !== mes - 1 ||
    control.getUTCDate() !== dia ||
    control.getUTCHours() !== hora ||
    control.getUTCMinutes() !== minuto ||
    control.getUTCSeconds() !== segundo
  ) {
    return null;
  }

  // Se toman los offsets 12 h antes y después del instante "como si fuera UTC"
  // (a ambos lados de cualquier cambio de horario cercano) y se elige el
  // candidato cuyo offset es coherente consigo mismo. Probar primero el offset
  // mayor (verano) resuelve la hora ambigua de otoño a su primera ocurrencia.
  const offsets = [
    offsetMadridMs(pared - 12 * 3_600_000),
    offsetMadridMs(pared + 12 * 3_600_000),
  ].sort((a, b) => b - a);
  for (const offset of offsets) {
    const candidato = pared - offset;
    if (offsetMadridMs(candidato) === offset) {
      return new Date(candidato).toISOString();
    }
  }
  // Hora inexistente (salto de primavera): se aplica el offset previo al salto.
  return new Date(pared - offsets[offsets.length - 1]).toISOString();
}

/**
 * Normaliza un campo opcional en string: recorta espacios y trata el string
 * vacío como ausente (`undefined`).
 */
function normalizarOpcional(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
