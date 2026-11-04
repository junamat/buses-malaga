# `db/`

Migraciones SQL del esquema GTFS + dominio (PostGIS), funciones de
map-matching y schedules de ingesta.

## Migraciones

Se aplican en orden numérico ascendente.

| Archivo | Contenido | Modos |
|---|---|---|
| `migrations/0001_schema_gtfs_dominio.sql` | Esquema completo: extensión `postgis`, tablas estáticas GTFS (`routes`, `trips`, `stop_times`, `stops`, `calendar_dates`), `shapes` (LINESTRING + índice GiST), `bus_positions` (índices por `cod_bus` y `last_update`), `official_minutes` e `ingest_log`. | Los tres (`supabase-cloud`, `supabase-local`, `local-postgres`) |
| `migrations/0002_extensions_pg_cron_pg_net.sql` | Extensiones `pg_cron` y `pg_net` para la ingesta programada. | **Solo** `supabase-cloud` y `supabase-local` |
| `migrations/0003_route_directions_destinos.sql` | Tabla `route_directions` (Destino legible por `(route_id, sentido)`, FK → `routes`, unicidad por `(route_id, sentido)`). | Los tres (`supabase-cloud`, `supabase-local`, `local-postgres`) |
| `migrations/0004_datos_usuario_rls.sql` | `favorites` (unicidad `NULLS NOT DISTINCT`) y `vehicle_contributions` con RLS por `auth.uid() = user_id` (lectura pública de aportaciones); `auth_login_attempts` para el bloqueo tras 5 fallos. Crea `anon`/`authenticated` y un `auth.uid()` compatible solo si no existen. | Los tres |
| `migrations/0005_local_auth.sql` | Credenciales (`local_auth_users`) y sesiones (`local_auth_sessions`) del adaptador `local-auth`. | **Solo** `local-postgres` |

### Nota de portabilidad

Las migraciones `0001`, `0003` y `0004` son el núcleo portable: solo necesitan
`postgis` (y, en el caso de `0003`, la tabla `routes` de `0001`), presentes en
los tres backends. `0004` usa los roles y `auth.uid()` de Supabase cuando
existen y, en Postgres puro, crea equivalentes; el repositorio fija los claims y
hace `SET LOCAL ROLE authenticated` en las operaciones de usuario, así que RLS
se aplica igual en los tres modos. `0005` solo es necesaria en `local-postgres`. La migración `0002` habilita `pg_cron`/`pg_net`, que
**no existen en un Postgres + PostGIS puro** (Vía B `local-postgres`); en ese
modo la ingesta periódica la dispara el adaptador `node-worker` (tarea 3.2) y
`0002` debe omitirse.

### Cómo se aplican por entorno

Los entornos de desarrollo local están documentados en
[`../README.dev.md`](../README.dev.md). Resumen de aplicación de migraciones:

| Entorno | Migraciones | Mecanismo |
|---|---|---|
| **Vía A** `supabase-local` | `0001` + `0002` + `0003` + `0004` | `npm run db:apply:supabase-local` (tras `npm run supabase:start`) |
| **Vía B** `local-postgres` | `0001` + `0003` + `0004` + `0005` | automático vía `docker-entrypoint-initdb.d` al `npm run localpg:up`; manual con `npm run db:apply:local-postgres` |
| `supabase-cloud` (prod) | `0001` + `0002` + `0003` + `0004` | pipeline de despliegue |

### Pendiente de hitos posteriores

- **Hito 4 (tarea 17.x):** funciones y schedules `pg_cron` de ingesta, recarga
  GTFS y purga.
