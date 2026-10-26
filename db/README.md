# `db/`

Migraciones SQL del esquema GTFS + dominio (PostGIS), funciones de
map-matching y schedules de ingesta.

## Migraciones

Se aplican en orden numérico ascendente.

| Archivo | Contenido | Modos |
|---|---|---|
| `migrations/0001_schema_gtfs_dominio.sql` | Esquema completo: extensión `postgis`, tablas estáticas GTFS (`routes`, `trips`, `stop_times`, `stops`, `calendar_dates`), `shapes` (LINESTRING + índice GiST), `bus_positions` (índices por `cod_bus` y `last_update`), `official_minutes` e `ingest_log`. | Los tres (`supabase-cloud`, `supabase-local`, `local-postgres`) |
| `migrations/0002_extensions_pg_cron_pg_net.sql` | Extensiones `pg_cron` y `pg_net` para la ingesta programada. | **Solo** `supabase-cloud` y `supabase-local` |

### Nota de portabilidad

La migración `0001` es el núcleo portable: solo necesita `postgis`, presente
en los tres backends. La migración `0002` habilita `pg_cron`/`pg_net`, que
**no existen en un Postgres + PostGIS puro** (Vía B `local-postgres`); en ese
modo la ingesta periódica la dispara el adaptador `node-worker` (tarea 3.2) y
`0002` debe omitirse.

### Cómo se aplican por entorno

Los entornos de desarrollo local están documentados en
[`../README.dev.md`](../README.dev.md). Resumen de aplicación de migraciones:

| Entorno | Migraciones | Mecanismo |
|---|---|---|
| **Vía A** `supabase-local` | `0001` + `0002` | `npm run db:apply:supabase-local` (tras `npm run supabase:start`) |
| **Vía B** `local-postgres` | `0001` únicamente | automático vía `docker-entrypoint-initdb.d` al `npm run localpg:up`; manual con `npm run db:apply:local-postgres` |
| `supabase-cloud` (prod) | `0001` + `0002` | pipeline de despliegue |

### Pendiente de hitos posteriores

- **Hito 3 (tarea 12.1):** migración incremental con las tablas de usuario
  (`favorites`, `vehicle_contributions`) y sus políticas RLS.
- **Hito 4 (tarea 17.x):** funciones y schedules `pg_cron` de ingesta, recarga
  GTFS y purga.
