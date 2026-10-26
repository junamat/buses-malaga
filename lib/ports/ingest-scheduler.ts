/**
 * Puerto `IngestScheduler` — disparo de la ingesta periódica + transporte HTTP.
 *
 * El Servicio_Ingesta queda detrás de este puerto. La función de ingesta y
 * normalización (recuperar la fuente, descartar filas malformadas, convertir
 * coordenadas a numérico `[lon, lat]`, insertar/recargar/purgar en el
 * repositorio) es única y compartida; lo que varía entre modos es solo quién
 * dispara los ciclos y cómo se realiza el `fetch` HTTP:
 *
 * - Adaptador `pg_cron` (`supabase-cloud`, `supabase-local`): los cuatro jobs
 *   se programan con `pg_cron` y el transporte HTTP lo realiza `pg_net` dentro
 *   de la base de datos.
 * - Adaptador `node-worker` (`local-postgres`): un proceso Node (o script con
 *   `setInterval` en desarrollo) y/o el endpoint `/api/ingest` disparan los
 *   mismos ciclos; el transporte HTTP lo realiza `fetch` de Node.
 *
 * (Requisitos 12.1, 12.2, 12.3)
 */

/** Los cuatro ciclos de ingesta definidos en el diseño. */
export type IngestJob =
  /** Posiciones de buses desde el CSV (cada 60 s). */
  | "posiciones"
  /** Recarga de datos estáticos GTFS + nombres legibles (cada 24 h). */
  | "gtfs"
  /** Purga de posiciones crudas fuera de la ventana de retención (cada 60 s). */
  | "purga"
  /** Scraping de minutos oficiales para calibración (intervalo de muestreo). */
  | "calibracion";

/**
 * Resultado de ejecutar un ciclo de ingesta. Ante fallo de una fuente, el
 * ciclo conserva los datos previos y registra el fallo (Requisitos 12.4, 12.5).
 */
export interface IngestResult {
  job: IngestJob;
  estado: "ok" | "fallo";
  /** Fuente afectada, cuando aplica (p. ej. la URL o el nombre del recurso). */
  fuente?: string;
  /** Mensaje de error cuando `estado === "fallo"`. */
  error?: string;
  /** Instante de la ejecución (ISO-8601). */
  runAt: string;
}

/**
 * Transporte HTTP a las fuentes externas. Abstrae `pg_net` (dentro de la BD)
 * frente a `fetch` de Node, manteniendo el mismo contrato para la función de
 * ingesta compartida. El timeout por defecto de posiciones es 30 s.
 */
export interface HttpTransport {
  /**
   * Realiza un GET a `url` y devuelve el cuerpo como texto. Debe respetar
   * `timeoutMs` y propagar un error si se excede o la fuente falla.
   */
  get(url: string, timeoutMs?: number): Promise<string>;
}

/**
 * Programador de la ingesta. La implementación cablea los cuatro `IngestJob`
 * a su disparador concreto (`pg_cron` o `node-worker`) y usa `HttpTransport`
 * para el acceso a las fuentes.
 */
export interface IngestScheduler {
  /** Transporte HTTP a fuentes externas asociado a este scheduler. */
  readonly transport: HttpTransport;

  /**
   * Programa (o reprograma) todos los ciclos con sus intervalos. En el
   * adaptador `pg_cron` registra los jobs en la base de datos; en `node-worker`
   * arranca los temporizadores del proceso.
   */
  start(): Promise<void>;

  /** Detiene todos los ciclos programados (relevante en `node-worker`). */
  stop(): Promise<void>;

  /**
   * Ejecuta un único ciclo bajo demanda. Es el punto de entrada del endpoint
   * `/api/ingest` en modo `local-postgres` y la unidad que comparten los tres
   * adaptadores. (Requisitos 12.1, 12.2, 12.6)
   */
  runOnce(job: IngestJob): Promise<IngestResult>;
}
