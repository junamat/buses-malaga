# Entornos de desarrollo local

Este proyecto es **portable** entre tres modos de ejecución, seleccionados por
la variable de entorno `BACKEND_PROVIDER` (alias `RUNTIME_MODE`):

| Modo | Uso | Ingesta | Auth |
|---|---|---|---|
| `supabase-cloud` | Producción (Vercel + Supabase cloud) | `pg_cron` + `pg_net` | Supabase Auth (GoTrue) |
| `supabase-local` | **Vía A** — dev de alta fidelidad | `pg_cron` + `pg_net` | Supabase Auth (GoTrue) |
| `local-postgres` | **Vía B** — Postgres + PostGIS puro | `node-worker` + `POST /api/ingest` | `local-auth` (usuario dev) |

La lógica de negocio depende solo de los puertos (`lib/ports`); el único punto
que conoce la correspondencia modo → adaptadores es `lib/config.ts`. El esquema
SQL vive en `db/migrations/` como única fuente de verdad (ver `db/README.md`).

Primero copia el archivo de ejemplo de variables de entorno:

```bash
cp .env.example .env.local
```

---

## Vía A — `supabase-local` (recomendada)

Usa el **Supabase CLI sobre Docker**. `supabase start` levanta exactamente la
misma pila que producción: Postgres + PostGIS, Auth (GoTrue), API REST, Studio
y las extensiones `pg_cron` / `pg_net`. Al usar los mismos adaptadores que
`supabase-cloud`, **no hay cambios de código** respecto a producción.

### Requisitos

- Docker en marcha.
- Supabase CLI instalado (`supabase --version`). Instalación:
  <https://supabase.com/docs/guides/local-development>.
- `psql` disponible en el `PATH` (cliente de Postgres) para aplicar migraciones.

### Arranque

```bash
# 1. Arranca la pila (Postgres+PostGIS, GoTrue, pg_cron, pg_net, Studio).
npm run supabase:start

# 2. Aplica las migraciones 0001 (esquema+PostGIS) y 0002 (pg_cron+pg_net).
npm run db:apply:supabase-local

# 3. Consulta las URLs y claves generadas (SUPABASE_URL, anon/service_role, DB).
npm run supabase:status
```

Copia a `.env.local` los valores que imprime `supabase status`:

```dotenv
BACKEND_PROVIDER=supabase-local
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<anon key de supabase status>
SUPABASE_SERVICE_ROLE_KEY=<service_role key de supabase status>
```

Arranca la app:

```bash
npm run dev
```

### Parada y reset

```bash
npm run supabase:stop     # detiene los contenedores
npm run supabase:reset    # stop + start + re-aplica migraciones desde cero
```

La configuración del CLI está en `supabase/config.toml` (puertos, Auth,
versión de Postgres). Solo `config.toml` se versiona; los artefactos locales
del CLI (`supabase/.temp`, `supabase/.branches`, `supabase/.env`) están en
`.gitignore`.

### Ingesta y autenticación en Vía A

Idénticas a producción: la ingesta periódica la programan los jobs `pg_cron`
(transporte HTTP con `pg_net`, tareas del Hito 4) y la autenticación la gestiona
GoTrue. La verificación de sesión en el borde de la API (Requisito 7.6) usa el
adaptador `supabase-auth`.

---

## Vía B — `local-postgres` (Postgres + PostGIS puro)

Usa un **Postgres + PostGIS sin `pg_cron` ni `pg_net`**. Es la pila mínima para
correr la app y la suite de tests sin depender de Supabase ni de su Docker; por
eso es la base de los tests de integración reproducibles en CI.

### Requisitos

- Docker en marcha (o un Postgres + PostGIS nativo; ver más abajo).
- `psql` en el `PATH`.

### Arranque con Docker (recomendado)

```bash
# 1. Levanta Postgres + PostGIS. El contenedor aplica SOLO la migración 0001
#    automáticamente (vía /docker-entrypoint-initdb.d) la primera vez.
npm run localpg:up
```

Configura `.env.local`:

```dotenv
BACKEND_PROVIDER=local-postgres
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/buses_malaga
# Supabase no se usa en esta Vía; deja SUPABASE_* vacías o sin definir.
LOCAL_AUTH_DEV_USER=true
```

Arranca la app:

```bash
npm run dev
```

> La migración `0002` (pg_cron/pg_net) **no se aplica** en esta Vía — esas
> extensiones no existen en la imagen `postgis/postgis`. La ingesta la cubre el
> adaptador `node-worker` (ver abajo).

Si necesitas reaplicar la migración manualmente (p. ej. contra una BD ya
creada), usa:

```bash
npm run db:apply:local-postgres
```

### Parada y reset

```bash
npm run localpg:down     # detiene y elimina el contenedor (conserva datos)
npm run localpg:reset    # elimina el volumen y recrea la BD (re-aplica 0001)
```

### Postgres + PostGIS nativo (alternativa sin Docker)

```bash
createdb buses_malaga
psql buses_malaga -c "CREATE EXTENSION IF NOT EXISTS postgis;"
npm run db:apply:local-postgres   # aplica SOLO 0001
```

Ajusta `DATABASE_URL` a tu instancia nativa.

### Variables de entorno de la Vía B

| Variable | Obligatoria | Descripción |
|---|---|---|
| `BACKEND_PROVIDER=local-postgres` | sí | Selecciona esta Vía |
| `DATABASE_URL` | sí | Conexión al Postgres + PostGIS local |
| `LOCAL_AUTH_DEV_USER` | no (def. `true`) | Usuario de desarrollo "sin login" |
| `INGEST_WORKER_ENABLED` | no (def. `false`) | Arrancar el worker de ingesta con la app |
| `INGEST_POLL_INTERVAL_MS` | no (def. `60000`) | Periodo del polling de posiciones |

### Ingesta en Vía B — worker y `POST /api/ingest`

Sin `pg_cron`/`pg_net`, los mismos cuatro ciclos de ingesta (posiciones, GTFS,
purga, calibración) los dispara un **worker en Node** (`setInterval`) y/o el
endpoint manual `POST /api/ingest`. Ambos invocan la **misma** función de
ingesta/normalización que `pg_cron` en producción; solo cambian el disparador y
el transporte HTTP (`fetch` de Node en lugar de `pg_net`).

`POST /api/ingest` solo está activo en modo `local-postgres` y no se expone en
producción.

**Worker periódico.** Con `INGEST_WORKER_ENABLED=true` en `.env.local`, el
servidor arranca el worker al iniciarse (`instrumentation.ts` →
`lib/ingestWorker.ts`). Al arrancar:

1. si la base no tiene líneas, lanza una recarga GTFS inicial (descarga ~30 MB;
   tarda unos segundos);
2. ejecuta un ciclo de posiciones y otro de purga inmediatos;
3. programa posiciones y purga cada 60 s y GTFS cada 24 h.

El worker vive en el proceso de `npm run dev`/`npm start`: tras cambiar
`INGEST_WORKER_ENABLED` hay que reiniciar el servidor.

**Disparo manual** (determinista; útil en tests o con el worker desactivado):

```bash
# Recarga GTFS (líneas, paradas, recorridos). Necesaria la primera vez si el
# worker está desactivado.
curl -X POST http://127.0.0.1:3000/api/ingest -d '{"job":"gtfs"}'

# Un ciclo de posiciones (el ciclo por defecto)
curl -X POST http://127.0.0.1:3000/api/ingest

# Purga de posiciones fuera de la ventana de 6 h
curl -X POST http://127.0.0.1:3000/api/ingest -d '{"job":"purga"}'
```

### Convenciones de datos de la EMT

- `codParada` es el **código público de parada** (el impreso en la parada y el
  que usa `informacionParada.html?codParada=`), que en el GTFS es `stop_code`,
  no `stop_id`.
- `sentido` usa la convención de la EMT (1 = ida, 2 = vuelta). El
  `direction_id` GTFS (0/1) se traduce a 1/2 al cargar `trips` y `shapes`.
- `last_update` llega en hora local de Madrid sin offset y se guarda en UTC.

### Autenticación en Vía B — `local-auth` / usuario de desarrollo

El adaptador `local-auth` cubre el mismo contrato que GoTrue con credenciales
en el Postgres local, e incluye un **modo "sin login"**: con
`LOCAL_AUTH_DEV_USER=true` (valor por defecto) se resuelve un `user_id` fijo de
desarrollo y no se requiere autenticación. Ponlo a `false` para exigir
credenciales locales. La verificación de sesión en el borde de la API
(Requisito 7.6) es idéntica a nivel de interfaz: cambia la implementación de
`AuthProvider`, no el contrato ni el comportamiento observable.

> El adaptador `local-auth` se implementa en la tarea 14.3.

---

## Notas

- El demonio de Docker puede requerir permisos adecuados del usuario. Si
  `docker` da `permission denied`, revisa tu configuración de Docker
  (pertenencia al grupo `docker` o ejecución con los privilegios adecuados).
- Para validar `docker-compose.yml` sin arrancar nada: `docker compose config`.
