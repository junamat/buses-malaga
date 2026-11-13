/**
 * Adaptador `IngestScheduler` para el modo `local-postgres` (`node-worker`).
 *
 * En desarrollo local no existen `pg_cron` ni `pg_net`: la ingesta la dispara
 * un proceso Node. Este adaptador implementa el puerto {@link IngestScheduler}
 * con dos piezas:
 *
 * - {@link NodeFetchTransport}: el transporte HTTP a las fuentes externas vía
 *   el `fetch` global de Node, con un `AbortController` que impone el timeout de
 *   30 s del contrato de ingesta. Es el reemplazo de `pg_net` en esta vía.
 * - {@link NodeWorkerIngestScheduler}: el disparador. `start()` arranca los
 *   temporizadores (`setInterval`) de los cuatro ciclos con sus intervalos;
 *   `stop()` los detiene; `runOnce(job)` ejecuta un único ciclo bajo demanda
 *   (es el punto de entrada de `POST /api/ingest`).
 *
 * El núcleo de la ingesta es **compartido**: `runOnce` delega en
 * `ejecutarIngesta` de `lib/ingest.ts`, exactamente la misma función que usará
 * el adaptador `pg_cron` del Hito 4. Solo cambian el disparador (temporizadores
 * de Node en lugar de `pg_cron`) y el transporte (`fetch` en lugar de `pg_net`).
 * El manejo de errores es idéntico: timeout de 30 s de la fuente, descarte de
 * filas malformadas (en `lib/ingest.ts`/`lib/normalize.ts`) y registro de cada
 * ciclo en `ingest_log` con la fuente afectada (Requisitos 12.4, 12.5).
 *
 * Alcance y seguridad: este worker es **solo para desarrollo** (`local-postgres`).
 * La factoría de `lib/config.ts` es la única que lo instancia, y únicamente para
 * ese modo; `POST /api/ingest` se cierra al resto de modos (no se expone en
 * producción). El ciclo de calibración (tarea 8.2) aún no está implementado:
 * `start()` no programa su temporizador si no hay callback, y `runOnce` devuelve
 * el fallo explicativo que ya construye el dispatcher compartido (no lanza).
 *
 * (Requisitos 12.1, 12.2, 12.3, 12.4, 12.5, 12.6)
 */

import type {
  HttpTransport,
  IngestJob,
  IngestResult,
  IngestScheduler,
  Repository,
} from "@/lib/ports";
import { request as httpsRequest } from "node:https";
import { rootCertificates } from "node:tls";

import {
  ejecutarIngesta,
  TIMEOUT_POSICIONES_MS,
  type IngestConfig,
} from "@/lib/ingest";
import {
  CA_INTERMEDIA_NAVEGA,
  HOST_NAVEGA,
} from "@/lib/adapters/navega-ca";

// ---------------------------------------------------------------------------
// Intervalos de los ciclos (modo desarrollo)
// ---------------------------------------------------------------------------

/** Intervalo del ciclo de posiciones: cada 60 s (Requisito 12.1). */
export const INTERVALO_POSICIONES_MS = 60_000;

/**
 * Intervalo del ciclo de posiciones con la API Navega: cada 20 s. El CSV de
 * datos abiertos se regenera una vez por minuto; `buses_servicios` tiene una
 * caché de 10 s, así que sondear más a menudo sí trae posiciones nuevas. 20 s
 * deja margen sobre esa caché sin acercarse a un posible límite de cuota (la
 * API responde 429 con un umbral que no está documentado).
 */
export const INTERVALO_POSICIONES_NAVEGA_MS = 20_000;

/** Intervalo del ciclo de purga: cada 60 s (Requisito 12.6). */
export const INTERVALO_PURGA_MS = 60_000;

/** Intervalo del ciclo de recarga GTFS: cada 24 h (Requisito 12.2). */
export const INTERVALO_GTFS_MS = 24 * 60 * 60 * 1_000;

/**
 * Intervalo de muestreo por defecto del ciclo de calibración (cada 10 min).
 * Solo se usa si hay un callback de calibración conectado en `IngestConfig`
 * (tarea 8.2); mientras no lo haya, el temporizador no se programa.
 */
export const INTERVALO_CALIBRACION_MS = 10 * 60 * 1_000;

/** Intervalos configurables por ciclo para `start()`. */
export interface IntervalosWorker {
  posicionesMs?: number;
  purgaMs?: number;
  gtfsMs?: number;
  calibracionMs?: number;
}

// ---------------------------------------------------------------------------
// Transporte HTTP: fetch de Node con timeout por AbortController
// ---------------------------------------------------------------------------

/**
 * Transporte HTTP sobre el `fetch` global de Node (reemplazo de `pg_net` en el
 * modo `local-postgres`). Impone el timeout con un `AbortController`: si la
 * fuente no responde dentro de `timeoutMs`, aborta la petición y lanza, de modo
 * que la ingesta compartida lo convierta en un `IngestResult` de fallo y
 * conserve los datos previos (Requisitos 12.4). Una respuesta no 2xx también
 * lanza, con el mismo contrato que el adaptador `pg_cron`.
 */
export class NodeFetchTransport implements HttpTransport {
  /** Host → certificado intermedio (PEM) que su servidor omite en la cadena. */
  private readonly caExtraPorHost: Readonly<Record<string, string>>;

  /**
   * @param caExtraPorHost Certificados intermedios a añadir a las raíces de
   *   Node, por host. Por defecto, el de la API Navega, cuyo servidor no envía
   *   la cadena completa (ver `lib/adapters/navega-ca.ts`). El `fetch` global
   *   no admite una CA propia, así que esos hosts se piden con `node:https`;
   *   el resto sigue yendo por `fetch`. El contrato (timeout, error en no 2xx)
   *   es el mismo por los dos caminos.
   */
  constructor(
    caExtraPorHost: Readonly<Record<string, string>> = {
      [HOST_NAVEGA]: CA_INTERMEDIA_NAVEGA,
    },
  ) {
    this.caExtraPorHost = caExtraPorHost;
  }

  async get(url: string, timeoutMs: number = TIMEOUT_POSICIONES_MS): Promise<string> {
    const caExtra = this.caExtraPorHost[hostDe(url)];
    if (caExtra !== undefined) {
      return getHttpsConCaExtra(url, caExtra, timeoutMs);
    }

    const controlador = new AbortController();
    const temporizador = setTimeout(() => {
      controlador.abort();
    }, timeoutMs);

    try {
      const respuesta = await fetch(url, { signal: controlador.signal });
      if (!respuesta.ok) {
        throw new Error(
          `La fuente "${url}" respondió con estado HTTP ${respuesta.status}.`,
        );
      }
      return await respuesta.text();
    } catch (error) {
      // Normaliza el aborto por timeout a un mensaje claro; el resto de errores
      // (red, DNS, etc.) se enriquecen con su causa subyacente antes de
      // propagarse para que el ciclo los registre.
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `Timeout de ${timeoutMs} ms al recuperar la fuente "${url}".`,
        );
      }
      throw enriquecerErrorFetch(url, error);
    } finally {
      clearTimeout(temporizador);
    }
  }
}

/** Host de una URL `https:`, o `""` si no lo es (no aplica CA extra). */
function hostDe(url: string): string {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" ? hostname : "";
  } catch {
    return "";
  }
}

/**
 * GET por `node:https` confiando, además de en las raíces de Node, en el
 * certificado intermedio `caExtra`. La verificación TLS sigue activa: solo se
 * completa la cadena que el servidor envía incompleta.
 *
 * `timeoutMs` acota la petición entera (conexión, cabeceras y cuerpo), igual
 * que el `AbortController` del camino `fetch`.
 */
function getHttpsConCaExtra(
  url: string,
  caExtra: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let terminado = false;
    const terminar = (error: Error | null, cuerpo = ""): void => {
      if (terminado) {
        return;
      }
      terminado = true;
      clearTimeout(temporizador);
      if (error !== null) {
        reject(error);
      } else {
        resolve(cuerpo);
      }
    };

    const peticion = httpsRequest(
      url,
      { method: "GET", ca: [...rootCertificates, caExtra] },
      (respuesta) => {
        const estado = respuesta.statusCode ?? 0;
        if (estado < 200 || estado >= 300) {
          respuesta.resume();
          terminar(
            new Error(`La fuente "${url}" respondió con estado HTTP ${estado}.`),
          );
          return;
        }
        const trozos: Buffer[] = [];
        respuesta.on("data", (trozo: Buffer) => trozos.push(trozo));
        respuesta.on("end", () =>
          terminar(null, Buffer.concat(trozos).toString("utf8")),
        );
        respuesta.on("error", (error) => terminar(errorDeRed(url, error)));
      },
    );

    const temporizador = setTimeout(() => {
      terminar(
        new Error(`Timeout de ${timeoutMs} ms al recuperar la fuente "${url}".`),
      );
      peticion.destroy();
    }, timeoutMs);

    peticion.on("error", (error) => terminar(errorDeRed(url, error)));
    peticion.end();
  });
}

/** Error de `node:https` con la URL y el código (`ECONNRESET`, TLS…) visibles. */
function errorDeRed(url: string, error: Error): Error {
  const codigo = (error as { code?: unknown }).code;
  const detalle =
    typeof codigo === "string" ? `${codigo} (${error.message})` : error.message;
  return new Error(`Fallo al recuperar la fuente "${url}": ${detalle}`);
}

/**
 * El `fetch` de Node (undici) reporta los fallos de red como un error genérico
 * con `message: "fetch failed"` y anida la causa real (p. ej. `ECONNRESET`,
 * `UND_ERR_SOCKET`, `ENOTFOUND`) en `error.cause`. Si solo se registra
 * `error.message`, un fallo intermitente queda como "fetch failed" sin
 * distinguir un reset de conexión reutilizada de un problema de DNS o TLS. Esta
 * función despliega la causa en el mensaje para que el `error` persistido en
 * `ingest_log` sea accionable, conservando la URL afectada.
 */
function enriquecerErrorFetch(url: string, error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Fallo al recuperar la fuente "${url}": ${String(error)}`);
  }

  const causa = (error as { cause?: unknown }).cause;
  if (causa === undefined || causa === null) {
    return error;
  }

  const codigo =
    typeof causa === "object" && causa !== null && "code" in causa
      ? String((causa as { code?: unknown }).code)
      : undefined;
  const detalleCausa =
    causa instanceof Error ? causa.message : String(causa);
  const detalle =
    codigo !== undefined ? `${codigo} (${detalleCausa})` : detalleCausa;

  return new Error(
    `Fallo al recuperar la fuente "${url}": ${error.message} — ${detalle}`,
  );
}

// ---------------------------------------------------------------------------
// Scheduler node-worker
// ---------------------------------------------------------------------------

/** Opciones de construcción del scheduler `node-worker`. */
export interface NodeWorkerIngestSchedulerOpciones {
  /** Repositorio de persistencia (única puerta de acceso a la BD). */
  repository: Repository;
  /**
   * Configuración resuelta de los ciclos: fuente de posiciones, ventana de
   * purga, recarga GTFS (de `lib/gtfs.ts`) y, cuando exista, calibración.
   */
  config: IngestConfig;
  /** Transporte HTTP. Por defecto {@link NodeFetchTransport}. */
  transport?: HttpTransport;
  /** Intervalos de los temporizadores. Por defecto los de este módulo. */
  intervalos?: IntervalosWorker;
  /** Reloj inyectable (para tests). Por defecto, la hora del sistema. */
  now?: () => Date;
}

/**
 * Programador de ingesta por `node-worker` para `local-postgres`.
 *
 * Implementa {@link IngestScheduler}. `runOnce` es la unidad compartida que
 * delega en `ejecutarIngesta` (núcleo común) y registra el resultado en
 * `ingest_log`; `start`/`stop` gestionan los temporizadores de desarrollo.
 */
export class NodeWorkerIngestScheduler implements IngestScheduler {
  readonly transport: HttpTransport;

  private readonly repository: Repository;
  private readonly config: IngestConfig;
  private readonly intervalos: Required<IntervalosWorker>;
  private readonly now: () => Date;

  /** Temporizadores activos por ciclo; `null` si el ciclo no está programado. */
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(opciones: NodeWorkerIngestSchedulerOpciones) {
    this.repository = opciones.repository;
    this.config = opciones.config;
    this.transport = opciones.transport ?? new NodeFetchTransport();
    this.now = opciones.now ?? (() => new Date());
    this.intervalos = {
      posicionesMs: opciones.intervalos?.posicionesMs ?? INTERVALO_POSICIONES_MS,
      purgaMs: opciones.intervalos?.purgaMs ?? INTERVALO_PURGA_MS,
      gtfsMs: opciones.intervalos?.gtfsMs ?? INTERVALO_GTFS_MS,
      calibracionMs:
        opciones.intervalos?.calibracionMs ?? INTERVALO_CALIBRACION_MS,
    };
  }

  /**
   * Ejecuta un único ciclo: delega en el núcleo compartido `ejecutarIngesta`
   * (idéntico al que usa el adaptador `pg_cron`) y registra el resultado en
   * `ingest_log` a través del repositorio. Un fallo al registrar **no** debe
   * enmascarar el resultado del ciclo: se aísla y el `IngestResult` del ciclo
   * se devuelve igualmente (Requisitos 12.1, 12.2, 12.5, 12.6).
   */
  async runOnce(job: IngestJob): Promise<IngestResult> {
    const resultado = await ejecutarIngesta(
      job,
      { transport: this.transport, repository: this.repository, now: this.now },
      this.config,
    );

    try {
      await this.repository.logIngesta(resultado);
    } catch {
      // El registro en ingest_log es observabilidad: si falla, no debe alterar
      // ni ocultar el resultado del ciclo, que es lo que el llamador necesita.
    }

    return resultado;
  }

  /**
   * Programa los temporizadores de los cuatro ciclos con sus intervalos:
   * posiciones (60 s), purga (60 s), GTFS (24 h) y calibración (intervalo de
   * muestreo). El ciclo de calibración solo se programa si hay un callback
   * conectado en `config` (tarea 8.2); mientras no lo haya, se omite en lugar
   * de registrar un fallo cada intervalo. Idempotente: un `start()` tras otro
   * reprograma limpiamente (hace `stop()` primero).
   */
  async start(): Promise<void> {
    await this.stop();

    this.programar("posiciones", this.intervalos.posicionesMs);
    this.programar("purga", this.intervalos.purgaMs);
    this.programar("gtfs", this.intervalos.gtfsMs);

    // La calibración no está implementada hasta la tarea 8.2: solo se programa
    // si su callback está conectado, para no disparar fallos periódicos.
    if (this.config.calibracion !== undefined) {
      this.programar("calibracion", this.intervalos.calibracionMs);
    }
  }

  /** Detiene todos los temporizadores programados. */
  async stop(): Promise<void> {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
  }

  /**
   * Programa un ciclo con `setInterval`, invocando `runOnce` en cada disparo.
   * Las excepciones del ciclo ya se capturan dentro de `runOnce`/el núcleo
   * compartido (que nunca lanza por un fallo de fuente), pero se envuelve en un
   * `catch` defensivo para que un error inesperado no derribe el proceso del
   * worker ni interrumpa las siguientes ejecuciones programadas.
   */
  private programar(job: IngestJob, intervaloMs: number): void {
    const timer = setInterval(() => {
      void this.runOnce(job).catch(() => {
        // Defensa en profundidad: un fallo del ciclo no debe detener el worker.
      });
    }, intervaloMs);

    // No mantener vivo el bucle de eventos de Node solo por los temporizadores.
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }

    this.timers.push(timer);
  }
}
