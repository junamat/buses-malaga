# Implementation Plan: Buses de Málaga

## Overview

Este plan traduce el diseño en una secuencia incremental de tareas de codificación, **organizada por hitos de entrega de producto** en lugar de por capas puramente técnicas. Cada hito termina en algo funcional y desplegable, de forma que el valor se entrega de manera incremental:

- **Hito 1 — "Buses en el mapa" (MVP visible).** Ver buses y paradas sobre el mapa OSM, refrescando cada minuto, con filtro por línea y sentido. Sin ETA, sin favoritos, sin login, sin geolocalización. Al terminarlo hay un mapa en vivo desplegable, ejecutable en local con el adaptador `node-worker`.
- **Hito 2 — "Estimación de llegada" (el diferenciador).** Añade el `Estimador_ETA` por parada (lógica pura + map-matching PostGIS), la calibración por scraping, la purga de posiciones, el endpoint de ETA, su visualización en el cliente y las paradas cercanas por geolocalización.
- **Hito 3 — "Funciones de usuario".** Añade autenticación, favoritos y aportaciones por vehículo, con RLS y endpoints protegidos.
- **Hito 4 — "Robustez y despliegue en producción".** Completa lo necesario para producción en Supabase cloud: adaptador `pg_cron` de posiciones y los tests de integración de API pendientes.
- **Fase 2 / opcional.** Barrios/distritos (Requisito 10), histórico agregado `segment_times` y el ajuste fino del modelo de calibración.

Cada hito mueve las tareas al punto de entrega donde aportan valor, pero **conserva intacto el contenido de cada tarea, sus referencias a requisitos y las 40 correctness properties con sus cláusulas `Validates`**. Lo que cambia es el agrupamiento y el orden; la trazabilidad no se rompe.

Producción sigue siendo **Vercel + Supabase cloud** con `pg_cron`/`pg_net`. El diseño añade **portabilidad de desarrollo local** mediante el patrón puertos/adaptadores: tres interfaces (repositorio de datos, `IngestScheduler`, `AuthProvider`) y tres modos seleccionables por `BACKEND_PROVIDER` (alias `RUNTIME_MODE`): `supabase-cloud` (producción), `supabase-local` (Vía A, Supabase CLI sobre Docker) y `local-postgres` (Vía B, Postgres+PostGIS puro sin `pg_cron`/`pg_net`). La portabilidad no es un requisito funcional nuevo; cada tarea de portabilidad traza a los requisitos existentes que habilita (ingesta 12.x, auth 7.6, datos transversales). El adaptador `node-worker` permite que el Hito 1 corra en local de forma determinista; el adaptador `pg_cron` de producción se completa en el Hito 4.

La lógica pura se concentra deliberadamente en módulos TypeScript sin dependencias de I/O (filtros, selección de ETA, normalización, favoritos, aportaciones, paginación, serialización GeoJSON, point-in-polygon) para que las 40 correctness properties del diseño puedan verificarse con `fast-check`. La geometría y el map-matching que viven en SQL/PostGIS se prueban ejecutando las funciones contra una base de datos de prueba. Gracias a la interfaz de repositorio común y al adaptador `node-worker`, los tests de lógica pura e integración pueden correr contra un **Postgres+PostGIS local** (modo `local-postgres`) sin depender de Supabase cloud ni de Docker de Supabase, lo que hace la suite reproducible en CI con un contenedor de Postgres estándar.

Por simplicidad de migración, el **esquema completo** (incluidas `official_minutes`, `ingest_log`, `favorites` y `vehicle_contributions`) se crea en una única migración en el Hito 1 (tarea 1.5); las tablas de usuario con RLS se habilitan en el Hito 3 (tarea 10.1) como migración incremental, de modo que cada hito solo activa lo que necesita.

## Tasks

Las tareas se agrupan en cuatro hitos de entrega más una sección de fase 2. Cada hito termina en un producto funcional y desplegable y cierra con un checkpoint.

### Hito 1 — "Buses en el mapa" (MVP visible)

**Objetivo de producto:** al terminar este hito existe un mapa OSM desplegable que muestra las posiciones de los buses y las paradas, se actualiza cada minuto y permite filtrar por línea y sentido. Sin ETA, sin favoritos, sin login, sin geolocalización. Corre en local con el adaptador `node-worker` y `POST /api/ingest`.

- [x] 1. Scaffolding del proyecto, puertos/adaptadores y selección de backend
  - [x] 1.1 Crear el proyecto Next.js, el runner de tests y la configuración base
    - Crear el proyecto Next.js (App Router, TypeScript) con la estructura de carpetas: `app/`, `app/api/`, `lib/` (lógica pura y clientes), `lib/ports/` (interfaces), `lib/adapters/` (adaptadores por modo), `db/` (migraciones SQL), `tests/`.
    - Configurar `tsconfig`, linter y el runner de tests (Vitest) con `fast-check` como dependencia de desarrollo.
    - Definir los tipos internos compartidos en `lib/types.ts`: `Bus`, `Parada`, `Linea`, `Sentido`, `PosicionCaptura`, `Favorito`, `Aportacion`, `GeoJSONFeatureCollection`.
    - _Requisitos: 11.1, 12.3_

  - [x] 1.2 Definir las interfaces de puertos y el selector de backend por entorno
    - Escribir en `lib/ports/` las tres interfaces del patrón puertos/adaptadores: `Repository` (acceso a Postgres/PostGIS), `IngestScheduler` (disparo de ingesta + transporte HTTP) y `AuthProvider` (identidad y verificación de sesión).
    - Escribir `lib/config.ts`: leer `BACKEND_PROVIDER` (alias `RUNTIME_MODE`) con valores `supabase-cloud` | `supabase-local` | `local-postgres` (por defecto `supabase-local` en desarrollo) y exponer una factoría que seleccione los adaptadores correspondientes.
    - Documentar `BACKEND_PROVIDER`/`RUNTIME_MODE`, la cadena de conexión de Postgres y las claves de Supabase en `.env.example`.
    - _Requisitos: 7.6, 11.1, 12.1, 12.3_

  - [x] 1.3 Implementar el repositorio de datos portable y su selección por modo
    - Escribir `lib/adapters/repository-postgres.ts`: una única implementación del puerto `Repository` sobre un driver de Postgres estándar, válida para los tres modos; solo varía la cadena de conexión inyectada según `BACKEND_PROVIDER`.
    - Cablear la factoría de `lib/config.ts` para resolver el repositorio; todos los servicios (API, estimador, calibración, favoritos, aportaciones, ingesta) accederán a datos a través de la interfaz `Repository`, nunca de un cliente de plataforma concreto.
    - _Requisitos: 11.1, 12.3_

  - [ ]* 1.4 Escribir test de integración del selector de backend y del repositorio
    - Verificar que cada valor de `BACKEND_PROVIDER` resuelve el adaptador de repositorio esperado y que el repositorio ejecuta una consulta trivial contra Postgres local (modo `local-postgres`).
    - _Requisitos: 11.1, 12.3_

  - [x] 1.5 Crear migración del esquema GTFS y de dominio
    - Habilitar las extensiones `postgis`, `pg_cron` y `pg_net`.
    - Crear tablas estáticas GTFS: `routes`, `trips`, `stop_times`, `stops`, `calendar_dates`.
    - Crear `shapes` con columna `geom_linestring geometry(LineString, 4326)` e índice GiST espacial.
    - Crear `bus_positions` (`cod_bus`, `cod_linea`, `sentido`, `lon`, `lat`, `cod_par_ini`, `last_update`, `captured_at`) con índices por `cod_bus` y `last_update`.
    - Crear `official_minutes` e `ingest_log`. Las tablas de usuario (`favorites`, `vehicle_contributions`) y su RLS se añaden como migración incremental en el Hito 3.
    - _Requisitos: 4.2, 12.1, 12.2, 12.5_

  - [x] 1.6 Configurar los entornos de desarrollo local (Vía A y Vía B)
    - Vía A (`supabase-local`): añadir la configuración y scripts del Supabase CLI (`supabase start` sobre Docker) que levanta Postgres+PostGIS, Auth (GoTrue), `pg_cron` y `pg_net`; documentar el arranque. Usa los mismos adaptadores que producción, sin cambios de código.
    - Vía B (`local-postgres`): añadir `docker-compose` (o instrucciones nativas) para Postgres+PostGIS local sin `pg_cron`/`pg_net`; documentar las variables de entorno, cómo ejecutar el worker de ingesta y/o `POST /api/ingest`, y el auth local / usuario de desarrollo.
    - Completar `.env.example` con la selección por `BACKEND_PROVIDER`/`RUNTIME_MODE` y las variables de cada vía.
    - _Requisitos: 7.6, 12.1, 12.2, 12.6_

  - [ ]* 1.7 Escribir tests de integración del esquema contra una BD de prueba
    - Verificar que PostGIS está disponible y que `shapes.geom_linestring` acepta LINESTRING.
    - Los tests corren contra Postgres local (modo `local-postgres`) sin depender de Supabase cloud.
    - _Requisitos: 4.2_

- [x] 2. Lógica pura de normalización, serialización, filtrado y selección de captura
  - [x] 2.1 Implementar normalización de coordenadas y parsing de fuentes
    - Escribir `lib/normalize.ts`: convertir coordenadas de string a numérico en orden `[lon, lat]`; parsear una fila del CSV `lineasyubicaciones.csv` a `PosicionCaptura`; descartar filas malformadas devolviéndolas por separado.
    - _Requisitos: 12.3_

  - [x] 2.2 Implementar serialización GeoJSON canónico
    - Escribir `lib/geojson.ts`: construir `FeatureCollection` con `geometry.coordinates` numéricas en orden `[lon, lat]` para Bus, Parada y Linea; incluir en Bus las propiedades `codBus`, `codLinea`, `sentido`, `last_update`, `captured_at` e indicador de obsolescencia derivado de la antigüedad.
    - Implementar también el parseo inverso para soportar el round-trip.
    - _Requisitos: 2.1, 2.2, 2.3, 11.5, 12.3_

  - [x] 2.3 Implementar filtros por Linea y Sentido
    - Escribir `lib/filters.ts`: filtrar por conjunto de Lineas, filtrar por Sentido, composición AND de ambos, limpieza de filtros que restaura el conjunto base, y detección de combinación sin resultados conservando el estado de filtros.
    - _Requisitos: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 2.4 Implementar selección de la captura más reciente por bus
    - Escribir `lib/positions.ts`: dado un conjunto de capturas, devolver por `codBus` la de `last_update` máximo.
    - _Requisitos: 2.5_

  - [ ]* 2.5 Escribir property test de round-trip de GeoJSON canónico
    - **Property 33: Round-trip de GeoJSON canónico**
    - **Validates: Requirements 11.5, 12.3**

  - [ ]* 2.6 Escribir property tests de cobertura y contenido de buses y paradas
    - **Property 4: Cobertura y contenido de los buses mostrados**
    - **Property 5: Las paradas se muestran en sus coordenadas**
    - **Validates: Requirements 2.1, 2.2, 2.3**

  - [ ]* 2.7 Escribir property tests de filtrado
    - **Property 7: Filtrado por un criterio es correcto y completo**
    - **Property 8: Los filtros combinados aplican lógica AND (confluencia)**
    - **Property 9: Limpiar filtros restaura la vista previa (round-trip)**
    - **Property 10: La combinación sin resultados conserva los filtros**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

  - [ ]* 2.8 Escribir property test de selección de captura más reciente
    - **Property 6: Se usa la captura más reciente por bus**
    - **Validates: Requirements 2.5**

- [x] 3. Ingesta de posiciones y recarga GTFS para desarrollo local
  - [x] 3.1 Extraer la función de ingesta/normalización compartida
    - Escribir `lib/ingest.ts` con la lógica de ingesta/normalización reutilizable e independiente del transporte: recuperar el cuerpo de una fuente, descartar filas malformadas (devolviéndolas por separado), normalizar coordenadas a numérico `[lon, lat]` e insertar/recargar/purgar a través de la interfaz `Repository`. El transporte HTTP se recibe por inyección (lo provee cada adaptador de `IngestScheduler`).
    - Esta función es única y compartida por los adaptadores `pg_cron` y `node-worker`; solo cambian el disparador y el transporte HTTP.
    - _Requisitos: 12.1, 12.3, 12.4, 12.5, 12.6_

  - [x] 3.2 Implementar el adaptador node-worker del IngestScheduler y el endpoint POST /api/ingest
    - Escribir `lib/adapters/ingest-node-worker.ts`: un disparador en Node (worker con `setInterval` o script de desarrollo) que dispara los mismos cuatro ciclos (posiciones, GTFS, purga, calibración) invocando la **misma** función de `lib/ingest.ts`, con transporte HTTP mediante `fetch` de Node (sin `pg_cron`/`pg_net`).
    - Implementar `POST /api/ingest` para disparar un ciclo de ingesta de forma manual/determinista; solo activo en modo `local-postgres`, no expuesto en producción.
    - El manejo de errores es idéntico al adaptador `pg_cron`: timeout de 30 s, descarte de filas malformadas y registro en `ingest_log` con la fuente afectada.
    - _Requisitos: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

  - [x] 3.3 Implementar la recarga GTFS (24 h) compartida
    - Escribir la función de recarga que repuebla `routes`, `trips`, `stop_times`, `shapes`, `calendar_dates` y los nombres legibles desde `lineasyparadas.geojson`, reconstruyendo `geom_linestring` de `shapes`. Invocable por el adaptador `node-worker` en local (y por el `pg_cron` en el Hito 4).
    - _Requisitos: 12.2_

  - [ ]* 3.4 Escribir test de integración de recarga GTFS y del endpoint /api/ingest
    - Verificar que una ejecución inserta las tablas estáticas y construye la geometría de `shapes`.
    - Verificar que `POST /api/ingest` (modo `local-postgres`) dispara un ciclo que inserta posiciones de forma determinista con el `fetch` mockeado.
    - _Requisitos: 12.1, 12.2_

- [x] 4. API de lectura y frontend del mapa (sin ETA)
  - [x] 4.1 Implementar manejo de errores canónico y validación de parámetros
    - Escribir `lib/apiErrors.ts` y un helper de validación: `404` recurso inexistente; `400` petición malformada; `400` listando parámetros obligatorios ausentes; cuerpo con `code` y `message`.
    - _Requisitos: 11.7, 11.8, 11.9_

  - [x] 4.2 Implementar endpoints de lectura geográficos (buses, paradas, líneas)
    - Implementar `GET /api/buses`, `GET /api/paradas`, `GET /api/lineas` (GeoJSON canónico, paginación ≤200 con cursor, filtros por `codLinea`/`sentido`). Sin endpoint de ETA ni de paradas cercanas en este hito.
    - _Requisitos: 2.1, 2.2, 2.3, 3.1, 3.2, 11.1, 11.3, 11.5_

  - [x] 4.3 Implementar lógica pura del estado del mapa
    - Escribir `lib/mapState.ts`: conmutador de capas que garantiza exactamente una capa base activa; conmutar preservando centro y zoom; recorte del zoom al rango [1, 19].
    - _Requisitos: 1.2, 1.4, 1.6_

  - [x] 4.4 Implementar el componente de mapa base
    - Renderizar Leaflet centrado en el área de la EMT con zoom inicial en [10,16], ≥2 capas base OSM (una activa por defecto), pan/zoom, y la indicación de error que conserva la capa previa si fallan las teselas.
    - _Requisitos: 1.1, 1.3, 1.5_

  - [x] 4.5 Implementar capas de buses y paradas con refresco
    - Pintar buses (con `codLinea` + `sentido`) y paradas (nombre + `codParada` al seleccionar) consumiendo la API; refrescar cada minuto con la captura más reciente; indicar ausencia de buses y marcar datos obsoletos con su antigüedad.
    - _Requisitos: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [x] 4.6 Implementar panel de filtros
    - Cablear `lib/filters.ts` a controles de Linea y Sentido (AND), limpieza de filtros y mensaje de combinación sin resultados conservando el estado.
    - _Requisitos: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ]* 4.7 Escribir property tests del estado del mapa
    - **Property 1: Exactamente una capa base activa**
    - **Property 2: Conmutar capa preserva centro y zoom**
    - **Property 3: El zoom queda recortado al rango permitido**
    - **Validates: Requirements 1.2, 1.4, 1.6**

  - [ ]* 4.8 Escribir tests de ejemplo e interacción del frontend
    - Zoom inicial en [10,16] y capa por defecto (1.3); fallo de teselas conserva capa previa (1.5); selección de parada muestra nombre y codParada (2.4); conjunto vacío de buses (2.6).
    - _Requisitos: 1.3, 1.5, 2.4, 2.6_

- [x] 5. Checkpoint Hito 1 - MVP visible en el mapa
  - Ejecutar todos los tests del hito, asegurar que pasan; verificar manualmente que el mapa muestra buses y paradas en local con `node-worker`; preguntar al usuario si surgen dudas.

### Hito 2 — "Estimación de llegada" (el diferenciador)

**Objetivo de producto:** al terminar este hito el usuario conoce el ETA del siguiente bus por parada (estimación de mejor esfuerzo con margen ±1 min), ve las paradas más cercanas por geolocalización y el modelo se calibra offline con los minutos oficiales. El esquema de calibración/observabilidad ya existe desde el Hito 1 (tarea 1.5).

- [x] 6. Lógica pura de paginación, geometría y distancia
  - [x] 6.1 Implementar paginación por cursor
    - Escribir `lib/pagination.ts`: partir un conjunto en páginas de como máximo 200 elementos, emitir cursor `next`, y garantizar que la unión de páginas recorridas reconstruye el conjunto sin duplicados ni omisiones.
    - _Requisitos: 11.3_

  - [x] 6.2 Implementar cálculo de distancia para paradas cercanas
    - Escribir en `lib/geometry.ts` el cálculo de distancia en metros entre ubicación de usuario y parada, y la selección de hasta 10 paradas dentro de 1000 m ordenadas por distancia ascendente.
    - _Requisitos: 6.2, 6.6_

  - [x]* 6.3 Escribir property tests de paginación y distancia de paradas cercanas
    - **Property 32: La paginación particiona el conjunto completo**
    - **Property 17: Paradas cercanas: radio, límite y orden**
    - **Property 18: La distancia mostrada coincide con la calculada**
    - **Validates: Requirements 11.3, 6.2, 6.6**

- [x] 7. Servicio de ingesta: purga de posiciones crudas
  - [x] 7.1 Implementar el job de purga (60 s, retención 6 h) invocable desde node-worker
    - Añadir a la ingesta compartida la purga que elimina posiciones de `bus_positions` con antigüedad superior a 21600 s y libera espacio, disparable por el adaptador `node-worker` en local (el schedule `pg_cron` de purga se completa en el Hito 4).
    - _Requisitos: 12.6_

  - [ ]* 7.2 Escribir tests de las funciones de ingesta y purga contra BD de prueba
    - **Property 38: Un fallo de fuente preserva los datos previos**
    - **Property 39: Un fallo de fuente queda registrado con su origen**
    - **Property 40: La purga elimina solo las posiciones fuera de la ventana de retención**
    - **Validates: Requirements 12.4, 12.5, 12.6**
    - El adaptador `node-worker` facilita estos tests: la función de ingesta se invoca directamente desde Node (sin `pg_cron`/`pg_net`) contra Postgres local, con el `fetch` a las fuentes mockeado, cubriendo la misma lógica que corre en producción.

- [x] 8. Servicio de calibración (muestreo básico)
  - [x] 8.1 Implementar parser de minutos oficiales
    - Escribir `lib/calibration.ts`: parsear el HTML de `informacionParada.html` extrayendo `<span class="minutosN">N min.</span>` por línea; descartar valores fuera de [0, 120] min (p. ej. el centinela 785) devolviendo los descartes para su registro.
    - _Requisitos: 5.1, 5.2_

  - [x] 8.2 Implementar job de calibración por scraping
    - Escribir la función de calibración (vía `node-worker` en local, `pg_net` en cloud) que muestree `informacionParada.html?codParada=XXX`, filtre con la lógica anterior, registre los descartes y almacene los valores válidos en `official_minutes`; si la web no está disponible, omitir el ciclo sin alterar el ETA de producción.
    - _Requisitos: 5.1, 5.2, 5.5_

  - [x]* 8.3 Escribir property test del filtrado de valores oficiales y test de ejemplo del parser
    - **Property 15: Los valores oficiales fuera de rango se descartan y registran**
    - **Validates: Requirements 5.2**
    - Añadir test de ejemplo del parser sobre HTML de muestra incluyendo el centinela 785.
    - _Requisitos: 5.1_

- [x] 9. Estimador_ETA con map-matching PostGIS
  - [x] 9.1 Implementar lógica pura de conversión distancia→tiempo y selección de ETA
    - Escribir `lib/eta.ts`: convertir distancia a lo largo del recorrido y velocidad estimada en ETA no negativo y monótono en la distancia; expresar el ETA en minutos enteros; seleccionar por línea el ETA mínimo considerando solo buses con ETA ≤ 60 min; marcar "ETA no disponible" cuando la posición más reciente supera 120 s; señalar el margen de ±1 min.
    - _Requisitos: 4.1, 4.2, 4.4, 4.6, 4.7_

  - [x] 9.2 Implementar funciones SQL/PostGIS de map-matching
    - Escribir funciones SQL que proyecten la posición más reciente de cada bus sobre el `shape` (`ST_LineLocatePoint` / `ST_LineSubstring`), calculen la distancia a lo largo del recorrido entre bus y parada, infieran velocidad de capturas consecutivas por `last_update`, y devuelvan el conjunto de ETA por línea para una parada aplicando la lógica de `lib/eta.ts`.
    - Garantizar que la salida de producción nunca incluye `official_minutes`.
    - _Requisitos: 4.1, 4.2, 5.4_

  - [x]* 9.3 Escribir property tests del estimador de ETA
    - **Property 11: Selección del ETA mínimo con cota de 60 minutos**
    - **Property 12: El ETA es no negativo y monótono en la distancia**
    - **Property 13: El ETA se expresa en minutos enteros**
    - **Property 14: Posición obsoleta implica ETA no disponible**
    - **Property 16: El ETA de producción no contiene minutos oficiales**
    - **Validates: Requirements 4.1, 4.2, 4.4, 4.6, 5.4**

  - [ ]* 9.4 Escribir tests de las funciones de map-matching contra BD de prueba
    - Verificar proyección sobre LINESTRING y cálculo de distancia a lo largo del recorrido con geometrías conocidas.
    - _Requisitos: 4.2_

- [x] 10. Endpoint de ETA, paradas cercanas y visualización en el cliente
  - [x] 10.1 Implementar endpoint de ETA
    - Implementar `GET /api/paradas/{codParada}/eta` invocando el `Estimador_ETA`; responder `200` con `{eta: null, disponible: false, motivo}` cuando no hay ETA disponible, de forma coherente con el estimador.
    - _Requisitos: 4.1, 11.2, 11.6_

  - [x] 10.2 Implementar endpoint de paradas cercanas
    - Implementar `GET /api/paradas/cercanas` (hasta 10 paradas en 1000 m ordenadas por distancia con distancia en metros).
    - _Requisitos: 6.2, 6.6_

  - [x] 10.3 Implementar geolocalización de paradas cercanas en el cliente
    - Pedir permiso, gestionar concesión/denegación/timeout de 10 s y ausencia de paradas en 1000 m, mostrando la distancia en metros vía `GET /api/paradas/cercanas`.
    - _Requisitos: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [x] 10.4 Implementar visualización de ETA en el cliente
    - Mostrar el ETA marcándolo como estimación de mejor esfuerzo con margen ±1 min, consumiendo `GET /api/paradas/{codParada}/eta`.
    - _Requisitos: 4.5, 4.7_

  - [x]* 10.5 Escribir property tests del contrato HTTP de ETA
    - **Property 34: ETA inexistente responde con éxito e indicador de no disponible**
    - **Validates: Requirements 11.6**

  - [x]* 10.6 Escribir test de interacción del timeout de geolocalización
    - Timeout de geolocalización a 10 s (6.5).
    - _Requisitos: 6.5_

- [x] 11. Checkpoint Hito 2 - Estimación de llegada
  - Ejecutar todos los tests de los hitos 1 y 2, asegurar que pasan; preguntar al usuario si surgen dudas.

### Hito 3 — "Funciones de usuario"

**Objetivo de producto:** al terminar este hito el usuario puede iniciar sesión, gestionar favoritos (paradas, líneas y combinaciones) y enviar aportaciones por vehículo, con aislamiento por usuario mediante RLS.

- [ ] 12. Datos de usuario con RLS
  - [~] 12.1 Crear migración de datos de usuario con RLS
    - Crear `favorites` (`id`, `user_id`, `tipo`, `cod_parada`, `cod_linea`) con restricción de unicidad por (`user_id`, `tipo`, `cod_parada`, `cod_linea`).
    - Crear `vehicle_contributions` (`id`, `user_id`, `cod_bus`, `opcion`, `created_at`).
    - Activar Row Level Security sobre ambas y definir políticas que restrinjan acceso por `auth.uid() = user_id`.
    - _Requisitos: 7.6, 8.1, 8.9, 9.1_

  - [ ]* 12.2 Escribir tests de integración de RLS y unicidad contra una BD de prueba
    - Verificar que la restricción de unicidad de `favorites` impide duplicados y que las políticas RLS aíslan por `user_id`.
    - Los tests corren contra Postgres local (modo `local-postgres`) sin depender de Supabase cloud.
    - _Requisitos: 8.9_

- [ ] 13. Lógica pura de favoritos y aportaciones
  - [~] 13.1 Implementar lógica pura de favoritos
    - Escribir `lib/favorites.ts`: alta validando existencia del elemento y unicidad (idempotencia), aplicación del límite de 500, consulta del conjunto (posiblemente vacío) y baja idempotente, todo conservando el resto de favoritos.
    - _Requisitos: 8.1, 8.2, 8.3, 8.4, 8.5, 8.7, 8.8, 8.9, 8.10_

  - [~] 13.2 Implementar lógica pura de aportaciones
    - Escribir `lib/contributions.ts`: catálogo de ≤10 opciones; validar que el `codBus` existe y que la opción pertenece al catálogo; persistir aportación válida; filtrar por la ventana de vigencia de 60 min al consultar.
    - _Requisitos: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [ ]* 13.3 Escribir property tests de favoritos
    - **Property 20: Marcar un favorito existente lo añade al conjunto del usuario**
    - **Property 21: Referenciar un elemento inexistente rechaza y preserva el conjunto**
    - **Property 22: La consulta de favoritos recupera el conjunto del usuario**
    - **Property 23: Añadir y luego eliminar un favorito preserva el resto**
    - **Property 24: Eliminar un favorito inexistente rechaza sin cambios**
    - **Property 25: Marcar un favorito es idempotente**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.7, 8.8, 8.9**

  - [ ]* 13.4 Escribir property tests de aportaciones
    - **Property 26: Una aportación válida queda persistida y asociada**
    - **Property 27: Solo se muestran las aportaciones vigentes**
    - **Property 28: codBus desconocido rechaza la aportación con motivo**
    - **Property 29: Una opción fuera del catálogo rechaza sin persistir**
    - **Validates: Requirements 9.1, 9.3, 9.4, 9.5, 9.6**

- [ ] 14. Autenticación y protección de operaciones (AuthProvider)
  - [~] 14.1 Implementar la verificación de sesión en el borde de la API sobre AuthProvider
    - Escribir `lib/auth.ts`: proteger los route handlers a través de la interfaz `AuthProvider` (resolver `user_id`, verificar sesión); cuando no hay sesión, rechazar la operación conservando los datos introducidos y exigir login. El contrato es idéntico en los tres modos; solo cambia el adaptador.
    - _Requisitos: 7.6_

  - [~] 14.2 Implementar el adaptador supabase-auth
    - Escribir `lib/adapters/auth-supabase.ts`: implementación del puerto `AuthProvider` que delega en Supabase Auth (GoTrue) y verifica el JWT de Supabase en el borde de la API. Adaptador usado en los modos `supabase-cloud` y `supabase-local`.
    - _Requisitos: 7.6_

  - [~] 14.3 Implementar el adaptador local-auth
    - Escribir `lib/adapters/auth-local.ts`: implementación local simple del puerto `AuthProvider` con credenciales en el Postgres local, incluyendo un **modo "sin login" / usuario de desarrollo** que resuelve un `user_id` fijo. Adaptador usado en el modo `local-postgres`.
    - _Requisitos: 7.6_

  - [ ]* 14.4 Escribir property test de operaciones protegidas sin sesión
    - **Property 19: Las operaciones protegidas sin sesión se rechazan sin mutar datos**
    - **Validates: Requirements 7.6**

  - [ ]* 14.5 Escribir tests de integración del flujo de autenticación
    - Verificar login con credenciales válidas, expiración de 30 días, bloqueo tras 5 intentos fallidos y logout contra Supabase Auth (adaptador `supabase-auth`).
    - Verificar que el adaptador `local-auth` resuelve el usuario de desarrollo y protege las operaciones por igual a nivel de contrato.
    - _Requisitos: 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 15. Endpoints protegidos y UI de usuario
  - [~] 15.1 Implementar endpoints de favoritos y aportaciones (protegidos)
    - Implementar `GET/POST /api/favoritos`, `DELETE /api/favoritos/{id}`, `GET/POST /api/buses/{codBus}/aportaciones`, cableando `lib/auth.ts`, `lib/favorites.ts` y `lib/contributions.ts`.
    - _Requisitos: 8.1, 8.5, 8.7, 9.1, 9.3, 7.6_

  - [~] 15.2 Implementar UI de login, favoritos y aportaciones en el cliente
    - UI de login/logout con el cliente Supabase; alta/consulta/baja de favoritos y alta/consulta de aportaciones cableando los endpoints protegidos.
    - _Requisitos: 7.1, 7.5, 8.1, 8.5, 8.7, 9.1, 9.3_

  - [ ]* 15.3 Escribir property tests del contrato HTTP de errores
    - **Property 35: Un recurso inexistente devuelve no encontrado**
    - **Property 36: Una petición malformada devuelve error de cliente**
    - **Property 37: Los parámetros obligatorios ausentes se identifican**
    - **Validates: Requirements 11.7, 11.8, 11.9**

- [~] 16. Checkpoint Hito 3 - Funciones de usuario
  - Ejecutar todos los tests de los hitos 1 a 3, asegurar que pasan; preguntar al usuario si surgen dudas.

### Hito 4 — "Robustez y despliegue en producción"

**Objetivo de producto:** al terminar este hito el sistema corre en producción sobre Supabase cloud con `pg_cron`/`pg_net` para la ingesta periódica y queda validado de extremo a extremo con los tests de integración de API pendientes.

- [ ] 17. Adaptador pg_cron del IngestScheduler (producción)
  - [~] 17.1 Implementar el adaptador pg_cron de posiciones (60 s)
    - Escribir migración SQL con la función de ingesta y el schedule `pg_cron` cada 60 s: `pg_net` hace GET a `lineasyubicaciones.csv` con timeout 30 s; normaliza coordenadas a numérico `[lon, lat]`; inserta filas válidas en `bus_positions` a través del repositorio.
    - Ante timeout/error o fuente no disponible, conservar los datos previos y escribir un registro en `ingest_log` con la fuente y el instante. Adaptador usado en los modos `supabase-cloud` y `supabase-local`.
    - _Requisitos: 12.1, 12.3, 12.4, 12.5_

  - [~] 17.2 Implementar el job de recarga GTFS (24 h) en el adaptador pg_cron
    - Escribir función SQL y schedule diario que invoque la recarga de `routes`, `trips`, `stop_times`, `shapes`, `calendar_dates` y los nombres legibles desde `lineasyparadas.geojson`, reconstruyendo `geom_linestring` de `shapes`.
    - _Requisitos: 12.2_

  - [~] 17.3 Implementar el job de purga (60 s, retención 6 h) en el adaptador pg_cron
    - Escribir función SQL y schedule cada 60 s que elimine las posiciones de `bus_positions` con antigüedad superior a 21600 s y libere espacio.
    - _Requisitos: 12.6_

- [ ] 18. Tests de integración de API y validación de producción
  - [ ]* 18.1 Escribir tests de integración de la API
    - Verificar que los endpoints responden ≤2 s, devuelven GeoJSON canónico en recursos geográficos, y el flujo extremo a extremo de favoritos/aportaciones con RLS activo.
    - _Requisitos: 11.1, 11.2, 11.4, 11.5_

- [~] 19. Checkpoint final - Validación completa
  - Ejecutar toda la suite de tests (unitarios, property-based e integración), asegurar que pasan; preguntar al usuario si surgen dudas.

### Extensión — Destino legible por línea y sentido

**Objetivo de producto:** mostrar el letrero de destino legible (p. ej. "San Andrés") asociado a cada `(Linea, Sentido)`, derivado del `trip_headsign` del GTFS, en lugar de un "Ida/Vuelta" genérico. Amplía piezas ya entregadas en el Hito 1 (ingesta GTFS, API de buses/líneas, panel de filtros y popups del mapa). Enfoque A: el Destino se modela por `(codLinea, sentido)` y cada Bus lo hereda de su par.

- [x] 22. Destino por `(Linea, Sentido)` extremo a extremo
  - [x] 22.1 Migración del esquema de destinos
    - Crear la tabla `route_directions` (`route_id` FK → `routes`, `sentido` integer, `destino` text) con unicidad por (`route_id`, `sentido`), como migración incremental nueva (no modificar las migraciones existentes).
    - _Requisitos: 2.8, 12.2_

  - [x] 22.2 Dominio e ingesta GTFS del destino
    - Añadir en `lib/types.ts` el `trip_headsign` opcional a `ViajeGtfs` y una entidad de Destino por `(codLinea, sentido)`.
    - En `lib/gtfs.ts`: capturar `trip_headsign` en `normalizarTrips`; derivar el Destino representativo por `(codLinea, sentido)` (headsign más frecuente; empate por orden lexicográfico) de forma determinista; incluirlo en `GtfsDataset` y persistirlo vía `Repository.recargarGtfs`.
    - _Requisitos: 2.8, 12.2_

  - [x] 22.3 Repositorio: persistir y leer destinos
    - Extender `Repository.recargarGtfs` para repoblar `route_directions` en la misma recarga transaccional, y exponer la lectura de destinos por `(codLinea, sentido)` necesaria para la API.
    - _Requisitos: 2.8, 11.10_

  - [x] 22.4 Exponer el destino en la API
    - Incluir `destino` en las propiedades de cada Bus de `GET /api/buses` (heredado de su `(codLinea, sentido)`) y por sentido en `GET /api/lineas`; omitir la propiedad cuando no haya Destino.
    - _Requisitos: 2.8, 11.10_

  - [x] 22.5 Mostrar el destino en el frontend
    - Usar el Destino real por sentido en `FilterPanel` (en vez del "Ida/Vuelta" fijo cuando exista) y en el popup/etiqueta de cada Bus del mapa.
    - _Requisitos: 2.8_

  - [ ]* 22.6 Property test de la herencia y derivación del destino
    - **Property 41: Herencia del Destino por `(Linea, Sentido)`**
    - **Validates: Requirements 2.8, 11.10**

### Tareas opcionales / fase 2

- [ ] 20. Lógica pura de inclusión geométrica point-in-polygon (fase 2)
  - [~] 20.1 Implementar inclusión geométrica point-in-polygon
    - Escribir en `lib/geometry.ts`: determinar si un punto está en el interior o sobre el límite de un polígono; usado por el filtro de barrios/distritos de fase 2.
    - _Requisitos: 10.2_

  - [ ]* 20.2 Escribir property tests de inclusión geométrica (fase 2)
    - **Property 30: Filtro por polígono es inclusión geométrica (interior y borde)**
    - **Property 31: Desactivar el filtro de barrio restaura según el resto de filtros**
    - **Validates: Requirements 10.2, 10.4**

- [ ]* 21.1 Implementar capa y filtro de barrios/distritos (Requisito 10)
  - Integrar datos de barrios/distritos del portal, ofrecer la capa seleccionable y cablear el filtro point-in-polygon de `lib/geometry.ts` al mapa, con restauración al desactivar y mensaje de área vacía conservando la capa de límites.
  - _Requisitos: 10.1, 10.2, 10.3, 10.4, 10.5_

- [ ]* 21.2 Implementar histórico agregado segment_times (fase 2)
  - Crear la tabla `segment_times` y un job de agregación de tiempos medios por tramo/franja horaria, para histórico sin retener posiciones crudas de forma indefinida.
  - _Requisitos: 12.6_

- [ ]* 21.3 Implementar ajuste fino del modelo de calibración (fase 2)
  - Consumir `official_minutes` en el `Servicio_Calibracion` para ajustar los parámetros del `Estimador_ETA` (p. ej. factor de velocidad por línea/tramo) más allá del muestreo básico, sin introducir los minutos oficiales en producción.
  - _Requisitos: 5.3, 5.4_

## Notes

- **Organización por hitos de entrega.** El plan prioriza el valor de producto: Hito 1 entrega un mapa en vivo con filtros; Hito 2 el ETA (diferenciador) y la geolocalización; Hito 3 las funciones de usuario; Hito 4 la robustez de producción. Cada hito termina en algo funcional y desplegable y cierra con un checkpoint.
- Las tareas marcadas con `*` son opcionales (tests y fase 2) y pueden omitirse para un MVP más rápido; las tareas de implementación core nunca llevan `*`.
- Cada tarea referencia los requisitos concretos que cubre; cada test de propiedad referencia su número de property y los requisitos que valida. La reorganización por hitos **conserva intactas** todas las referencias a requisitos y las 40 correctness properties con sus cláusulas `Validates`.
- El patrón puertos/adaptadores (repositorio de datos, `IngestScheduler`, `AuthProvider`) permite que producción (Vercel + Supabase cloud con `pg_cron`/`pg_net`) y desarrollo local (`supabase-local`, `local-postgres`) convivan sin tocar la lógica de negocio; la portabilidad traza a requisitos existentes (ingesta 12.x, auth 7.6, datos transversales) y no introduce requisitos nuevos.
- El adaptador `node-worker` (Hito 1) permite correr la ingesta en local de forma determinista sin `pg_net`; el adaptador `pg_cron` de producción se completa en el Hito 4 invocando la **misma** función de `lib/ingest.ts`; solo cambian el disparador y el transporte HTTP.
- La lógica pura se aísla en `lib/` para permitir property-based testing con `fast-check` (mínimo 100 iteraciones por propiedad); las funciones SQL/PostGIS se prueban contra una BD de prueba con entradas generadas. Gracias al repositorio portable y al adaptador `node-worker`, los tests corren contra Postgres+PostGIS local (modo `local-postgres`) en CI sin Supabase cloud.
- Las 40 correctness properties del diseño quedan cubiertas exactamente una vez: 1–3 (estado del mapa, Hito 1), 4–6 (buses/paradas/captura, Hito 1), 7–10 (filtros, Hito 1), 33 (GeoJSON, Hito 1); 17–18 (paradas cercanas), 32 (paginación), 11–16 (ETA y calibración), 38–40 (ingesta/purga) y 34 (contrato ETA) en el Hito 2; 19 (auth), 20–25 (favoritos), 26–29 (aportaciones), 35–37 (contrato HTTP de errores) en el Hito 3; 30–31 (barrios) en fase 2.
- Los checkpoints validan incrementalmente cada hito antes de avanzar.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "1.5", "2.1", "2.2", "2.3", "2.4", "4.1", "4.3"] },
    { "id": 3, "tasks": ["1.4", "1.6", "2.5", "2.6", "2.7", "2.8", "3.1", "4.2", "4.4", "4.7"] },
    { "id": 4, "tasks": ["3.2", "3.3", "4.5", "4.6", "4.8", "6.1", "6.2"] },
    { "id": 5, "tasks": ["3.4", "6.3", "7.1", "8.1", "9.1"] },
    { "id": 6, "tasks": ["7.2", "8.2", "9.2", "20.1"] },
    { "id": 7, "tasks": ["8.3", "9.3", "9.4", "10.1", "10.2", "20.2"] },
    { "id": 8, "tasks": ["10.3", "10.4", "10.5", "10.6", "12.1"] },
    { "id": 9, "tasks": ["12.2", "13.1", "13.2", "14.1"] },
    { "id": 10, "tasks": ["13.3", "13.4", "14.2", "14.3", "14.4"] },
    { "id": 11, "tasks": ["14.5", "15.1"] },
    { "id": 12, "tasks": ["15.2", "15.3"] },
    { "id": 13, "tasks": ["17.1", "17.2", "17.3"] },
    { "id": 14, "tasks": ["18.1"] }
  ]
}
```
