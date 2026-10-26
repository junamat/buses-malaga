/**
 * Hook de arranque del servidor Next.js. Se ejecuta una vez por proceso.
 *
 * Arranca el worker de ingesta `node-worker` en modo `local-postgres` cuando
 * `INGEST_WORKER_ENABLED=true` (ver `lib/ingestWorker.ts`). El import es
 * dinámico y condicionado al runtime Node para que `pg` no se empaquete en el
 * runtime Edge.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { iniciarWorkerIngesta } = await import("./lib/ingestWorker");
    await iniciarWorkerIngesta();
  }
}
