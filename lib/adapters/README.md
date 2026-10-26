# `lib/adapters/`

Adaptadores concretos de los puertos, seleccionados por `BACKEND_PROVIDER`
(`supabase-cloud` | `supabase-local` | `local-postgres`). Incluye el repositorio
Postgres portable, los schedulers de ingesta (`pg_cron`, `node-worker`) y los
proveedores de autenticación. Implementados a partir de la tarea 1.3.

## Implementados

- `repository-postgres.ts` (tarea 1.3) — única implementación del puerto
  `Repository` sobre el driver `pg`, válida para los tres modos. La lógica
  SQL/PostGIS es portable; lo único que varía es la cadena de conexión
  (`config.databaseUrl`), inyectada por la factoría de `lib/config.ts`. Los
  constructores de SQL y los mapeadores fila → dominio son funciones puras
  verificables sin base de datos (ver `repository-postgres.test.ts`). El test de
  integración contra un Postgres+PostGIS real es la tarea 1.4 (opcional).
  Incluye `logIngesta`, que registra cada ciclo de ingesta en `ingest_log`
  (fuente + estado + instante, Requisito 12.5).

- `ingest-node-worker.ts` (tarea 3.2) — implementación del puerto
  `IngestScheduler` para el modo `local-postgres`. `NodeFetchTransport` es el
  transporte HTTP sobre el `fetch` global de Node con timeout de 30 s por
  `AbortController` (reemplazo de `pg_net`). `NodeWorkerIngestScheduler` dispara
  los cuatro ciclos con `setInterval` (posiciones/purga cada 60 s, GTFS cada
  24 h, calibración en su intervalo de muestreo cuando exista) y expone
  `runOnce` para el disparo bajo demanda de `POST /api/ingest`. El núcleo de la
  ingesta es compartido (`lib/ingest.ts` + `lib/gtfs.ts`); `runOnce` delega en
  `ejecutarIngesta` y registra el resultado en `ingest_log`. Es un adaptador
  **solo de desarrollo**: la factoría lo cablea únicamente en `local-postgres` y
  el endpoint se cierra (404) en el resto de modos.
