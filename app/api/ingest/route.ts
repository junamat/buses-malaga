/**
 * `POST /api/ingest` — disparador manual/determinista de un ciclo de ingesta.
 *
 * Es el punto de entrada bajo demanda del adaptador `node-worker` en el modo de
 * desarrollo `local-postgres` (Vía B): dispara **un** ciclo (`posiciones`,
 * `gtfs`, `purga` o `calibracion`) a través del mismo núcleo compartido que usa
 * el worker periódico (`NodeWorkerIngestScheduler.runOnce` →
 * `ejecutarIngesta`). Sirve para arrancar la ingesta sin esperar al temporizador
 * y para que los tests de integración (tarea 3.4) disparen un ciclo determinista
 * con el `fetch` mockeado (Requisitos 12.1, 12.2, 12.6).
 *
 * Seguridad / alcance (NO expuesto en producción): este endpoint solo está
 * activo cuando `BACKEND_PROVIDER`/`RUNTIME_MODE` resuelve a `local-postgres`.
 * En los modos `supabase-cloud` y `supabase-local` la ingesta la programa
 * `pg_cron`/`pg_net` dentro de la base de datos, y este endpoint responde `404`
 * como si no existiera, de modo que no quede expuesto en producción.
 *
 * Contrato de errores (coherente con los errores canónicos del diseño): cuerpo
 * de error con `code` y `message`; `404` cuando el endpoint no aplica al modo;
 * `400` cuando el `job` solicitado es desconocido o la petición está malformada.
 * El resultado del ciclo se devuelve como JSON: `200` tanto si el ciclo terminó
 * en `ok` como en `fallo`, porque un fallo de fuente es un resultado válido del
 * contrato de ingesta (se conservan los datos previos y queda registrado en
 * `ingest_log`), no un error de la petición HTTP.
 */

import { NextResponse } from "next/server";

import type { IngestJob, IngestScheduler } from "@/lib/ports";
import { loadBackendConfig, createIngestScheduler } from "@/lib/config";
import { getRepository } from "@/lib/apiRepository";

/** Los cuatro ciclos válidos, para validar el `job` recibido. */
const JOBS_VALIDOS: readonly IngestJob[] = [
  "posiciones",
  "gtfs",
  "purga",
  "calibracion",
];

/** Ciclo por defecto cuando la petición no indica `job`. */
const JOB_POR_DEFECTO: IngestJob = "posiciones";

/** Cuerpo de error canónico del diseño: `{ code, message }`. */
interface CuerpoError {
  code: string;
  message: string;
}

/** Construye una respuesta de error canónica con el estado HTTP indicado. */
function error(status: number, code: string, message: string): NextResponse {
  const cuerpo: CuerpoError = { code, message };
  return NextResponse.json(cuerpo, { status });
}

/** ¿Es `value` uno de los `IngestJob` conocidos? */
function esIngestJob(value: unknown): value is IngestJob {
  return (
    typeof value === "string" &&
    (JOBS_VALIDOS as readonly string[]).includes(value)
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Resolver el modo. Solo `local-postgres` expone este endpoint; cualquier
  //    otro modo (o una configuración inválida) responde 404 (no expuesto).
  //    Se construyen únicamente el repositorio y el scheduler de ingesta: este
  //    endpoint no usa autenticación, así que no se instancia el AuthProvider
  //    (cuyo adaptador llega en el Hito 3). Construir el backend completo aquí
  //    fallaría al crear ese adaptador y dejaría el endpoint inalcanzable.
  let ingestScheduler: IngestScheduler;
  try {
    const config = loadBackendConfig();
    if (config.provider !== "local-postgres") {
      return error(
        404,
        "no_encontrado",
        "El endpoint de ingesta solo está disponible en modo local-postgres.",
      );
    }
    // Repositorio memoizado del proceso: comparte el pool de `pg` con los
    // endpoints de lectura y el worker, en lugar de abrir uno por petición.
    const repository = getRepository();
    ingestScheduler = createIngestScheduler(config, repository);
  } catch {
    // Config inválida/incompleta: no revelar detalles, tratar como no disponible.
    return error(
      404,
      "no_encontrado",
      "El endpoint de ingesta no está disponible en esta configuración.",
    );
  }

  // 2. Determinar el ciclo solicitado. El cuerpo es opcional; por defecto
  //    "posiciones". Un cuerpo presente pero no-JSON es una petición malformada.
  let job: IngestJob = JOB_POR_DEFECTO;
  const texto = await request.text();
  if (texto.trim() !== "") {
    let cuerpo: unknown;
    try {
      cuerpo = JSON.parse(texto);
    } catch {
      return error(
        400,
        "peticion_malformada",
        "El cuerpo de la petición no es JSON válido.",
      );
    }

    if (cuerpo !== null && typeof cuerpo === "object" && "job" in cuerpo) {
      const solicitado = (cuerpo as { job: unknown }).job;
      if (!esIngestJob(solicitado)) {
        return error(
          400,
          "job_invalido",
          `El ciclo "${String(solicitado)}" no es válido. ` +
            `Valores admitidos: ${JOBS_VALIDOS.join(", ")}.`,
        );
      }
      job = solicitado;
    }
  }

  // 3. Disparar un único ciclo por el núcleo compartido y devolver el resultado.
  //    runOnce ya registra el resultado en ingest_log; un fallo de fuente es un
  //    resultado válido (200), no un error de la petición HTTP.
  const resultado = await ingestScheduler.runOnce(job);
  return NextResponse.json(resultado, { status: 200 });
}
