/**
 * Arranque del worker de ingesta periódica (`node-worker`) en el proceso del
 * servidor, para el modo `local-postgres` (Vía B).
 *
 * Lo invoca `instrumentation.ts` una vez por proceso de servidor Node. Solo
 * arranca si el modo es `local-postgres` **y** `INGEST_WORKER_ENABLED=true`; en
 * los modos `supabase-*` la ingesta la programa `pg_cron` (Hito 4) y aquí no se
 * hace nada.
 *
 * Al arrancar:
 * 1. Si la base no tiene datos estáticos (ninguna línea), lanza una recarga GTFS
 *    inicial para que el mapa tenga paradas y líneas desde el primer momento.
 * 2. Ejecuta un ciclo de posiciones y otro de purga inmediatos (los
 *    temporizadores de `start()` disparan por primera vez al cabo de 60 s).
 * 3. Programa los ciclos periódicos con `NodeWorkerIngestScheduler.start()`.
 *
 * Usa el repositorio memoizado del proceso (`getRepository`), de modo que el
 * worker y los route handlers comparten un único pool de `pg`.
 */

import type { IngestResult, IngestScheduler } from "@/lib/ports";
import { createIngestScheduler, loadBackendConfig } from "@/lib/config";
import { getRepository } from "@/lib/apiRepository";

/** Clave global para no arrancar dos workers en el mismo proceso. */
const CLAVE_GLOBAL = "__busesMalagaIngestWorker";

type GlobalConWorker = typeof globalThis & {
  [CLAVE_GLOBAL]?: IngestScheduler;
};

/**
 * Arranca el worker si procede. Devuelve el scheduler arrancado, o `null` si el
 * modo/configuración no lo requiere. No lanza: un error de configuración o de
 * la primera ingesta se registra en consola y no tumba el servidor.
 */
export async function iniciarWorkerIngesta(
  env: Record<string, string | undefined> = process.env,
): Promise<IngestScheduler | null> {
  const global = globalThis as GlobalConWorker;
  if (global[CLAVE_GLOBAL] !== undefined) {
    return global[CLAVE_GLOBAL];
  }

  let scheduler: IngestScheduler;
  try {
    const config = loadBackendConfig(env);
    if (config.provider !== "local-postgres" || !config.ingest?.workerEnabled) {
      return null;
    }
    scheduler = createIngestScheduler(config, getRepository(env));
  } catch (error) {
    console.error("[ingest-worker] No se pudo configurar el worker:", error);
    return null;
  }

  global[CLAVE_GLOBAL] = scheduler;
  await scheduler.start();
  console.info("[ingest-worker] Worker de ingesta arrancado (local-postgres).");

  // Primeras ejecuciones en segundo plano: no bloquean el arranque del servidor.
  void primerasEjecuciones(scheduler, env);

  return scheduler;
}

async function primerasEjecuciones(
  scheduler: IngestScheduler,
  env: Record<string, string | undefined>,
): Promise<void> {
  try {
    const { items } = await getRepository(env).listLineas({ limite: 1 });
    if (items.length === 0) {
      const gtfs = await scheduler.runOnce("gtfs");
      logResultadoCiclo("Recarga GTFS inicial", gtfs);
    }
    const posiciones = await scheduler.runOnce("posiciones");
    logResultadoCiclo("Ingesta inicial de posiciones", posiciones);
    await scheduler.runOnce("purga");
  } catch (error) {
    console.error("[ingest-worker] Fallo en las ejecuciones iniciales:", error);
  }
}

/**
 * Registra en consola el resultado de un ciclo de arranque. Un ciclo `ok` se
 * informa a nivel info; un `fallo` se registra a nivel error **con su causa**
 * (`error`), de modo que un fallo intermitente (p. ej. timeout o HTTP no-2xx de
 * la fuente, que el contrato trata preservando los datos previos) sea visible
 * sin tener que consultar `ingest_log`.
 */
function logResultadoCiclo(etiqueta: string, resultado: IngestResult): void {
  if (resultado.estado === "ok") {
    console.info(`[ingest-worker] ${etiqueta}: ok`);
    return;
  }
  const causa = resultado.error ?? "sin detalle";
  console.error(`[ingest-worker] ${etiqueta}: fallo — ${causa}`);
}

/** Detiene y olvida el worker del proceso (pensado para tests). */
export async function detenerWorkerIngesta(): Promise<void> {
  const global = globalThis as GlobalConWorker;
  const scheduler = global[CLAVE_GLOBAL];
  if (scheduler !== undefined) {
    await scheduler.stop();
    delete global[CLAVE_GLOBAL];
  }
}
