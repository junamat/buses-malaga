# `lib/ports/`

Interfaces del patrón puertos/adaptadores. La lógica de negocio depende solo de
estas interfaces, nunca de un adaptador o cliente de plataforma concreto.

- `repository.ts` — `Repository`: acceso a Postgres/PostGIS (consultas y
  persistencia del modelo interno, incluido SQL geométrico, map-matching,
  distancia, point-in-polygon y purga).
- `ingest-scheduler.ts` — `IngestScheduler`: disparo de la ingesta periódica
  (`pg_cron` vs `node-worker`) y transporte HTTP a las fuentes (`pg_net` vs
  `fetch`). Expone también `HttpTransport`.
- `auth-provider.ts` — `AuthProvider`: identidad, sesión y verificación en el
  borde de la API (`supabase-auth` GoTrue vs `local-auth` con usuario de dev).

Importa desde el barrel `@/lib/ports`. Los adaptadores concretos viven en
`@/lib/adapters` y se seleccionan en `@/lib/config` según `BACKEND_PROVIDER`.
Definidas en la tarea 1.2.
