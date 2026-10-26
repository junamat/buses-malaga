/**
 * Ciclo de calibración por scraping de minutos oficiales (tarea 8.2).
 *
 * El Servicio_Calibracion muestrea la web de la EMT
 * (`informacionParada.html?codParada=<cod>`), que renderiza en el HTML los
 * minutos de espera por línea, extrae los valores válidos con la lógica pura de
 * `lib/calibration.ts` (descartando los fuera de `[0, 120]`, p. ej. el centinela
 * 785) y los almacena en `official_minutes` a través del puerto `Repository`
 * (Requisitos 5.1, 5.2).
 *
 * Estos minutos son **solo** verdad de referencia para calibrar y validar el
 * estimador offline: no entran en las respuestas de producción (Requisito 5.4,
 * Property 16). El `Estimador_ETA` de producción vive en `lib/eta.ts` y en el
 * map-matching PostGIS, y no consume `official_minutes`.
 *
 * Contrato de errores (Requisito 5.5): si la web no está disponible —o falla el
 * muestreo de una parada—, el ciclo **omite** ese muestreo sin alterar el ETA de
 * producción y sin lanzar. Como en el resto de ciclos de ingesta, un fallo se
 * devuelve como `IngestResult` con `estado: "fallo"` para registrarlo en
 * `ingest_log`; nunca propaga una excepción al disparador.
 *
 * Igual que la recarga GTFS, es lógica pura respecto a la plataforma: usa el
 * `HttpTransport` y el `Repository` inyectados en `IngestDeps`; no conoce
 * `pg_net`, `fetch` ni la cadena de conexión. Se conforma a la firma
 * `CicloCalibracion` de `lib/ingest.ts` para conectarse en
 * `IngestConfig.calibracion` sin modificar el núcleo de ingesta.
 */

import type { CicloCalibracion, IngestDeps } from "@/lib/ingest";
import type { IngestResult, NuevoMinutoOficial, Repository } from "@/lib/ports";
import type { CodParada } from "@/lib/types";
import { parsearMinutosOficiales } from "@/lib/calibration";

/**
 * URL base de la página de información de parada de la EMT. El `codParada` se
 * añade como query param en cada muestreo. (Ver `SPEC.md`.)
 */
export const INFORMACION_PARADA_URL_DEFECTO =
  "https://www.emtmalaga.es/emt-mobile/informacionParada.html";

/** Timeout por muestreo (ms). Alineado con el timeout de ingesta (30 s). */
export const TIMEOUT_CALIBRACION_MS = 30_000;

/**
 * Número máximo de paradas a muestrear por ciclo. La calibración es muestreo
 * básico (tarea 8.2): se limita para no martillear la web de la EMT en cada
 * ejecución. El ajuste fino del modelo es fase 2 (tarea 21.3).
 */
export const MAX_PARADAS_POR_CICLO = 50;

/** Opciones del ciclo de calibración. */
export interface CalibracionOpciones {
  /** URL base de `informacionParada.html`. Por defecto, la de la EMT. */
  baseUrl?: string;
  /** Timeout por petición en ms. Por defecto {@link TIMEOUT_CALIBRACION_MS}. */
  timeoutMs?: number;
  /** Máximo de paradas por ciclo. Por defecto {@link MAX_PARADAS_POR_CICLO}. */
  maxParadas?: number;
  /**
   * Proveedor de los códigos de parada a muestrear. Por defecto se obtienen del
   * repositorio (`listParadas`); se inyecta en tests para determinismo.
   */
  obtenerCodParadas?: (
    repository: Repository,
    limite: number,
  ) => Promise<CodParada[]>;
}

/** Construye la URL de muestreo de una parada. */
export function urlInformacionParada(baseUrl: string, codParada: CodParada): string {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}codParada=${encodeURIComponent(codParada)}`;
}

/**
 * Obtiene por defecto hasta `limite` códigos de parada del repositorio, usando
 * la primera página de `listParadas` (el muestreo básico no necesita recorrer
 * todas las paradas en un ciclo).
 */
async function obtenerCodParadasPorDefecto(
  repository: Repository,
  limite: number,
): Promise<CodParada[]> {
  const pagina = await repository.listParadas(undefined, { limite });
  return pagina.items.map((p) => p.codParada);
}

/**
 * Ejecuta el ciclo de calibración: muestrea las paradas, filtra los minutos
 * válidos y los persiste en `official_minutes`. Devuelve el `IngestResult` del
 * ciclo (`ok` si se completó —aunque no haya habido valores válidos—, `fallo`
 * si no se pudo obtener la lista de paradas o persistir). Nunca lanza.
 */
export async function ejecutarCalibracion(
  deps: IngestDeps,
  opciones: CalibracionOpciones = {},
): Promise<IngestResult> {
  const ahora = (deps.now ?? (() => new Date()))();
  const runAt = ahora.toISOString();
  const baseUrl = opciones.baseUrl ?? INFORMACION_PARADA_URL_DEFECTO;
  const timeoutMs = opciones.timeoutMs ?? TIMEOUT_CALIBRACION_MS;
  const maxParadas = opciones.maxParadas ?? MAX_PARADAS_POR_CICLO;
  const obtener = opciones.obtenerCodParadas ?? obtenerCodParadasPorDefecto;

  // 1. Resolver qué paradas muestrear. Un fallo aquí no toca datos de
  //    producción: se reporta como fallo del ciclo.
  let codParadas: CodParada[];
  try {
    codParadas = await obtener(deps.repository, maxParadas);
  } catch (error) {
    return fallo(baseUrl, error, runAt);
  }

  // 2. Muestrear cada parada de forma independiente. El fallo de una (web no
  //    disponible, HTML inesperado) se omite sin abortar el ciclo ni alterar el
  //    ETA de producción (Requisito 5.5).
  const validos: NuevoMinutoOficial[] = [];
  let fallosDeFuente = 0;
  for (const codParada of codParadas) {
    let html: string;
    try {
      html = await deps.transport.get(
        urlInformacionParada(baseUrl, codParada),
        timeoutMs,
      );
    } catch {
      fallosDeFuente += 1;
      continue;
    }

    const { validos: minutos } = parsearMinutosOficiales(html);
    for (const m of minutos) {
      // La página no expone el codLinea de forma estructurada por span en el
      // muestreo básico; se asocia a la parada y se deja el refinamiento por
      // línea (parsing del `<li>` completo) para el ajuste fino de fase 2
      // (tarea 21.3). Se usa `codLinea: 0` como marcador "sin línea resuelta".
      validos.push({ codParada, codLinea: 0, minutos: m.minutos });
    }
  }

  // 3. Persistir los valores válidos. Un fallo de escritura se reporta como
  //    fallo del ciclo sin propagar la excepción.
  try {
    if (validos.length > 0) {
      await deps.repository.insertMinutosOficiales(validos);
    }
  } catch (error) {
    return fallo(baseUrl, error, runAt);
  }

  // Si todas las paradas fallaron en origen, se considera la web no disponible
  // (Requisito 5.5): el ciclo no aportó datos, pero no es un error de escritura.
  if (codParadas.length > 0 && fallosDeFuente === codParadas.length) {
    return {
      job: "calibracion",
      estado: "fallo",
      fuente: baseUrl,
      error: "La web de información de parada no está disponible.",
      runAt,
    };
  }

  return { job: "calibracion", estado: "ok", fuente: baseUrl, runAt };
}

/**
 * Adaptador de {@link ejecutarCalibracion} a la firma `CicloCalibracion` de
 * `lib/ingest.ts`, para conectarlo en `IngestConfig.calibracion` sin modificar
 * el núcleo de ingesta. Usa las opciones por defecto.
 */
export const cicloCalibracion: CicloCalibracion = async (deps) => {
  return ejecutarCalibracion(deps);
};

/** Construye un `CicloCalibracion` con opciones personalizadas. */
export function crearCicloCalibracion(
  opciones: CalibracionOpciones,
): CicloCalibracion {
  return async (deps) => ejecutarCalibracion(deps, opciones);
}

/** Construye el `IngestResult` de fallo del ciclo de calibración. */
function fallo(fuente: string, error: unknown, runAt: string): IngestResult {
  return {
    job: "calibracion",
    estado: "fallo",
    fuente,
    error: error instanceof Error ? error.message : String(error),
    runAt,
  };
}
