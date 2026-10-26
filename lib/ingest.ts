/**
 * Función de ingesta/normalización compartida (independiente del transporte).
 *
 * El Servicio_Ingesta queda detrás del puerto `IngestScheduler`. La lógica que
 * recupera una fuente, descarta filas malformadas, normaliza coordenadas a
 * numérico `[lon, lat]` e inserta/purga en el repositorio es **única y
 * compartida**; lo que varía entre modos de ejecución es solo *quién* dispara
 * los ciclos y *cómo* se realiza el `fetch` HTTP:
 *
 * - Adaptador `pg_cron` (`supabase-cloud`, `supabase-local`, Hito 4): los jobs
 *   se programan con `pg_cron` y el transporte HTTP lo realiza `pg_net`.
 * - Adaptador `node-worker` (`local-postgres`, tarea 3.2): un proceso Node (o
 *   `setInterval`) y/o `POST /api/ingest` disparan los mismos ciclos; el
 *   transporte HTTP lo realiza `fetch` de Node.
 *
 * Este módulo es puro respecto a la plataforma: depende solo de las interfaces
 * `Repository` (persistencia) y `HttpTransport` (acceso a fuentes), ambas
 * inyectadas. No conoce `pg_net`, `fetch`, ni la cadena de conexión concreta.
 *
 * Responsabilidades cubiertas aquí (tarea 3.1):
 *
 * - Recuperar el cuerpo de una fuente vía `HttpTransport` con el timeout del
 *   ciclo (posiciones: 30 s) (Requisito 12.1).
 * - Parsear/normalizar el CSV reutilizando `lib/normalize.ts`, descartando
 *   filas malformadas y devolviéndolas por separado (Requisito 12.3).
 * - Insertar las filas válidas a través de `Repository` (Requisito 12.1).
 * - Purgar las posiciones crudas fuera de la ventana de retención (12.6).
 * - Ante timeout/error o fuente no disponible, **conservar los datos previos**
 *   (no se borra nada) y reportar el fallo con la fuente afectada mediante
 *   `IngestResult` (`estado: "fallo"`), para que el llamador lo registre en
 *   `ingest_log` (Requisitos 12.4, 12.5). La función nunca lanza por un fallo
 *   de fuente: lo devuelve como resultado.
 *
 * Alcance: la recarga GTFS (tarea 3.3) y el cableado del scheduler/endpoint
 * (tarea 3.2) se conectan aquí mediante puntos de extensión diseñados para que
 * esas tareas no tengan que modificar este archivo.
 */

import type { HttpTransport, IngestJob, IngestResult } from "@/lib/ports";
import type { Repository } from "@/lib/ports";
import {
  parsearPosiciones,
  type FilaDescartada,
} from "@/lib/normalize";

// ---------------------------------------------------------------------------
// Constantes del contrato de ingesta
// ---------------------------------------------------------------------------

/**
 * Timeout del ciclo de posiciones, en milisegundos. El diseño y el Requisito
 * 12.4 fijan 30 s: si la fuente no responde dentro de este plazo se considera
 * no disponible para la ejecución y se conservan los datos previos.
 */
export const TIMEOUT_POSICIONES_MS = 30_000;

/**
 * Ventana de retención por defecto de las posiciones crudas, en segundos
 * (21600 s / 6 h). La purga elimina lo que sea más antiguo que esta ventana
 * (Requisito 12.6).
 */
export const VENTANA_RETENCION_SEGUNDOS = 21_600;

/** Separador de campos del CSV `lineasyubicaciones.csv`. */
const SEPARADOR_CSV = ",";

// ---------------------------------------------------------------------------
// Dependencias inyectadas
// ---------------------------------------------------------------------------

/**
 * Dependencias comunes a los ciclos de ingesta. El `transport` y el
 * `repository` los provee el adaptador de `IngestScheduler` (node-worker o
 * pg_cron). `now` permite inyectar el reloj en los tests; por defecto usa la
 * hora del sistema.
 */
export interface IngestDeps {
  /** Transporte HTTP a las fuentes externas (pg_net o fetch de Node). */
  transport: HttpTransport;
  /** Repositorio de persistencia (única puerta de acceso a la BD). */
  repository: Repository;
  /** Reloj inyectable (ISO-8601). Por defecto, la hora del sistema. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Ciclo de posiciones (cada 60 s)
// ---------------------------------------------------------------------------

/** Opciones del ciclo de ingesta de posiciones. */
export interface IngestPosicionesOpciones {
  /** URL del CSV de posiciones (`lineasyubicaciones.csv`). */
  fuenteUrl: string;
  /** Timeout de la petición, en ms. Por defecto {@link TIMEOUT_POSICIONES_MS}. */
  timeoutMs?: number;
}

/**
 * Resultado detallado del ciclo de posiciones. Extiende `IngestResult` con el
 * detalle de filas insertadas y descartadas, para que el llamador pueda
 * registrarlas en `ingest_log` sin recalcularlas. En caso de fallo de fuente,
 * `insertadas` es 0 y `descartadas` está vacío (no se tocó nada).
 */
export interface ResultadoIngestaPosiciones {
  resultado: IngestResult;
  /** Número de capturas válidas insertadas en `bus_positions`. */
  insertadas: number;
  /** Filas malformadas descartadas, con su motivo (Requisito 12.3). */
  descartadas: FilaDescartada[];
}

/**
 * Ejecuta el ciclo de ingesta de posiciones: recupera el CSV por el transporte
 * inyectado, normaliza y descarta filas malformadas, e inserta las válidas.
 *
 * Contrato de errores (Requisitos 12.4, 12.5): si la fuente no responde dentro
 * del timeout o falla por cualquier motivo, **no se modifica nada** en la BD y
 * se devuelve un `IngestResult` con `estado: "fallo"`, la `fuente` afectada y
 * el `error`, para que el llamador lo escriba en `ingest_log`. Nunca lanza por
 * un fallo de fuente.
 *
 * Las filas malformadas no interrumpen la ingesta de las válidas: se recogen en
 * `descartadas` (Requisito 12.3) y se insertan igualmente las filas correctas.
 */
export async function ingerirPosiciones(
  deps: IngestDeps,
  opciones: IngestPosicionesOpciones,
): Promise<ResultadoIngestaPosiciones> {
  const ahora = (deps.now ?? (() => new Date()))();
  const runAt = ahora.toISOString();
  const { fuenteUrl } = opciones;
  const timeoutMs = opciones.timeoutMs ?? TIMEOUT_POSICIONES_MS;

  // 1. Recuperar el cuerpo de la fuente. Un fallo aquí (timeout/error/fuente
  //    no disponible) preserva los datos previos: no se toca la BD.
  let cuerpo: string;
  try {
    cuerpo = await deps.transport.get(fuenteUrl, timeoutMs);
  } catch (error) {
    return {
      resultado: resultadoFallo("posiciones", fuenteUrl, error, runAt),
      insertadas: 0,
      descartadas: [],
    };
  }

  // 2. Normalizar/parsear reutilizando lib/normalize.ts. Las coordenadas se
  //    convierten a numérico [lon, lat] y las filas malformadas se separan.
  const filas = parsearLineasCsv(cuerpo);
  const { validas, descartadas } = parsearPosiciones(filas, runAt);

  // 3. Persistir las filas válidas. Un fallo de escritura también se reporta
  //    como fallo del ciclo (sin propagar excepción al disparador).
  try {
    if (validas.length > 0) {
      await deps.repository.insertPosiciones(validas);
    }
  } catch (error) {
    return {
      resultado: resultadoFallo("posiciones", fuenteUrl, error, runAt),
      insertadas: 0,
      descartadas,
    };
  }

  return {
    resultado: {
      job: "posiciones",
      estado: "ok",
      fuente: fuenteUrl,
      runAt,
    },
    insertadas: validas.length,
    descartadas,
  };
}

// ---------------------------------------------------------------------------
// Ciclo de purga (cada 60 s)
// ---------------------------------------------------------------------------

/** Opciones del ciclo de purga. */
export interface IngestPurgaOpciones {
  /**
   * Ventana de retención en segundos. Por defecto
   * {@link VENTANA_RETENCION_SEGUNDOS} (21600 s / 6 h).
   */
  ventanaSegundos?: number;
}

/** Resultado detallado del ciclo de purga. */
export interface ResultadoPurga {
  resultado: IngestResult;
  /** Número de posiciones crudas eliminadas. */
  purgadas: number;
}

/**
 * Ejecuta el ciclo de purga: elimina las posiciones crudas con antigüedad mayor
 * que la ventana de retención a través de `Repository.purgePosicionesAntiguas`
 * (Requisito 12.6). Un fallo del repositorio se reporta como `estado: "fallo"`
 * sin propagar la excepción al disparador.
 */
export async function purgarPosiciones(
  deps: IngestDeps,
  opciones: IngestPurgaOpciones = {},
): Promise<ResultadoPurga> {
  const ahora = (deps.now ?? (() => new Date()))();
  const runAt = ahora.toISOString();
  const ventanaSegundos =
    opciones.ventanaSegundos ?? VENTANA_RETENCION_SEGUNDOS;

  try {
    const purgadas =
      await deps.repository.purgePosicionesAntiguas(ventanaSegundos);
    return {
      resultado: { job: "purga", estado: "ok", runAt },
      purgadas,
    };
  } catch (error) {
    return {
      resultado: resultadoFallo("purga", undefined, error, runAt),
      purgadas: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Puntos de extensión para tareas 3.2 (scheduler) y 3.3 (recarga GTFS)
// ---------------------------------------------------------------------------

/**
 * Recarga GTFS (cada 24 h). La implementación concreta —repoblar `routes`,
 * `trips`, `stop_times`, `shapes`, `calendar_dates` y los nombres legibles,
 * reconstruyendo `geom_linestring`— es la tarea 3.3. Aquí se fija únicamente la
 * firma para que el dispatcher pueda delegar sin acoplarse a su contenido.
 */
export type RecargaGtfs = (
  deps: IngestDeps,
) => Promise<IngestResult>;

/**
 * Ciclo de calibración (scraping de minutos oficiales). La implementación es la
 * tarea 8.2; aquí solo se declara el punto de extensión.
 */
export type CicloCalibracion = (
  deps: IngestDeps,
) => Promise<IngestResult>;

/**
 * Configuración que un adaptador de `IngestScheduler` (tarea 3.2) pasa al
 * dispatcher compartido: las fuentes/ventanas de cada ciclo y las funciones de
 * los ciclos que aún no viven en este módulo (recarga GTFS y calibración).
 *
 * Diseñado para que 3.2/3.3 conecten sus piezas **sin modificar este archivo**:
 * el dispatcher consume estas opciones y delega en las funciones compartidas de
 * posiciones y purga, o en los callbacks inyectados para GTFS y calibración.
 */
export interface IngestConfig {
  /** Opciones del ciclo de posiciones (URL de la fuente y timeout). */
  posiciones: IngestPosicionesOpciones;
  /** Opciones del ciclo de purga (ventana de retención). */
  purga?: IngestPurgaOpciones;
  /** Implementación de la recarga GTFS (tarea 3.3). */
  recargaGtfs?: RecargaGtfs;
  /** Implementación del ciclo de calibración (tarea 8.2). */
  calibracion?: CicloCalibracion;
}

/**
 * Despacha un único ciclo de ingesta a su función compartida y devuelve el
 * `IngestResult` canónico. Es el núcleo que invocan por igual el adaptador
 * `node-worker` (tarea 3.2) y el adaptador `pg_cron` (Hito 4): solo cambia el
 * disparador y el `HttpTransport` inyectado en `deps`.
 *
 * Los ciclos aún no implementados en este módulo (GTFS, calibración) se delegan
 * en los callbacks de `config`; si no se proporcionan, se devuelve un fallo
 * explicativo en lugar de lanzar, coherente con el contrato de `IngestResult`.
 */
export async function ejecutarIngesta(
  job: IngestJob,
  deps: IngestDeps,
  config: IngestConfig,
): Promise<IngestResult> {
  switch (job) {
    case "posiciones": {
      const { resultado } = await ingerirPosiciones(deps, config.posiciones);
      return resultado;
    }
    case "purga": {
      const { resultado } = await purgarPosiciones(deps, config.purga);
      return resultado;
    }
    case "gtfs":
      return ejecutarCicloDelegado("gtfs", deps, config.recargaGtfs);
    case "calibracion":
      return ejecutarCicloDelegado("calibracion", deps, config.calibracion);
    default:
      return asegurarExhaustivo(job);
  }
}

// ---------------------------------------------------------------------------
// Helpers internos (puros / sin I/O propio)
// ---------------------------------------------------------------------------

/**
 * Parte el cuerpo de un CSV en filas de campos crudos. Ignora líneas en blanco
 * y recorta el retorno de carro (`\r`) de finales de línea estilo Windows.
 *
 * El portal de la EMT publica el CSV de posiciones con los campos entre comillas
 * dobles y una fila de cabecera (`"codBus","codLinea",...`). Se recortan las
 * comillas que envuelven cada campo de forma tolerante: un campo sin comillas se
 * deja intacto. No se soporta el caso (no observado en esta fuente) de un
 * separador `,` dentro de un campo entrecomillado. `lib/normalize.ts` valida
 * cada campo después y descarta la fila de cabecera por no ser numérica.
 */
export function parsearLineasCsv(cuerpo: string): string[][] {
  const filas: string[][] = [];
  for (const linea of cuerpo.split("\n")) {
    const limpia = linea.replace(/\r$/, "");
    if (limpia.trim() === "") {
      continue;
    }
    filas.push(limpia.split(SEPARADOR_CSV).map(desentrecomillar));
  }
  return filas;
}

/**
 * Recorta las comillas dobles que envuelven un campo CSV, si las tiene, y los
 * espacios alrededor. Un campo sin comillas se devuelve solo con el recorte de
 * espacios, de modo que la función es segura tanto para la fuente de posiciones
 * (entrecomillada) como para los CSV GTFS (planos).
 */
function desentrecomillar(campo: string): string {
  const t = campo.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1);
  }
  return t;
}

/** Construye un `IngestResult` de fallo con la fuente y el mensaje de error. */
function resultadoFallo(
  job: IngestJob,
  fuente: string | undefined,
  error: unknown,
  runAt: string,
): IngestResult {
  const resultado: IngestResult = {
    job,
    estado: "fallo",
    error: mensajeError(error),
    runAt,
  };
  if (fuente !== undefined) {
    resultado.fuente = fuente;
  }
  return resultado;
}

/** Normaliza cualquier valor lanzado a un mensaje de error legible. */
function mensajeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Ejecuta un ciclo delegado (GTFS o calibración) a través de su callback. Si no
 * hay implementación conectada, devuelve un fallo explicativo en vez de lanzar.
 */
async function ejecutarCicloDelegado(
  job: IngestJob,
  deps: IngestDeps,
  ciclo: RecargaGtfs | CicloCalibracion | undefined,
): Promise<IngestResult> {
  if (ciclo === undefined) {
    return {
      job,
      estado: "fallo",
      error: `Ciclo "${job}" no implementado: falta el callback en IngestConfig.`,
      runAt: new Date().toISOString(),
    };
  }
  return ciclo(deps);
}

/** Garantía de exhaustividad en el `switch` sobre `IngestJob`. */
function asegurarExhaustivo(value: never): never {
  throw new Error(`IngestJob no contemplado: ${String(value)}`);
}
