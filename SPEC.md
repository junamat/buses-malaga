# Buses de Málaga
## Una mejor\* aproximación al seguimiento de autobuses de la EMT de Málaga
\*esperemos

### Justificación
La EMT cuenta con aplicaciones para iOS, Android y una aplicación web compatible con la mayoría de navegadores web, sin embargo, lleva sin ampliar un lavado de cara el suficiente tiempo como para que en ciertos momentos se sienta obsoleta. Las funciones clave, como la recarga de tarjetas mediante NFC, visualizado de buses en tiempo real con sus distancias estimadas en minutos y otras cuantas más funcionan, aunque a veces con fallos inexplicables. De modo que esta aplicación está destinada a ampliar funcionalmente la aplicación oficial pero también a intentar conseguir ser más fiable que esta.

### Recursos

Todas las fuentes de datos abiertos provienen del portal del Ayuntamiento de Málaga
(<https://datosabiertos.malaga.eu/>), grupo *Transporte*. Salvo que se indique lo
contrario, se publican bajo licencia de datos abiertos del Ayuntamiento y no
requieren autenticación.

#### 1. Posiciones de autobuses en tiempo real

Dataset: `ubicaciones-de-autobuses-emt-en-tiempo-real`. Posición de cada vehículo
de la EMT, **actualizada cada 1 minuto**. Se publica en tres recursos: CSV, GeoJSON
y una variante GeoJSON "apta para FIWARE".

**Fuente elegida: el CSV.**

- `https://datosabiertos.malaga.eu/recursos/transporte/EMT/EMTlineasUbicaciones/lineasyubicaciones.csv`
- Campos: `codBus`, `codLinea`, `sentido`, `lon`, `lat`, `codParIni`, `last_update`.
- También accesible vía API CKAN:
  `https://datosabiertos.malaga.eu/api/3/action/datastore_search?resource_id=<id>`
- Clave de join con el resto de fuentes: `codLinea` (float, p. ej. `1.0`) = `route_id`.

El CSV es el recurso más completo: es el único que incluye `last_update` (timestamp
por vehículo, imprescindible para estimar velocidad entre capturas), además de
`sentido` y `codParIni` (parada de origen).

**Variante FIWARE — descartada.** El recurso
`lineasyubicacionesfiware.geojson` se evaluó y se descarta por ser estrictamente
inferior al CSV para este proyecto:

- Pese a la extensión `.geojson`, **no es GeoJSON válido**: es un array JSON plano de
  entidades del smart data model FIWARE `Vehicle` (`type: "Vehicle"`,
  `id: "vehicle:bus:<n>"`, `lineNumber`, `category`, `vehicleType`), no un
  `FeatureCollection`.
- Solo expone esas seis claves: **no trae marca temporal** (`last_update` /
  `observedAt`), ni `sentido`, ni `codParIni`. Es un subconjunto de los campos del CSV.
- Las coordenadas del `location` (`Point`) vienen como **strings**, no como números
  → requieren conversión igual que el CSV, sin ventaja alguna.

El modelo `Vehicle` solo aportaría valor si el proyecto integrara un Context Broker
FIWARE (Orion) a futuro; incluso en ese escenario convendría construir las entidades
NGSI a partir del CSV (más completo) y añadirles el `observedAt` que el feed oficial
omite. Queda fuera del alcance del MVP.

#### 2. GTFS de la EMT (estático)

El portal publica el GTFS completo de la EMT **desglosado en CSVs** con nombres de
columna GTFS estándar, bajo
`https://datosabiertos.malaga.eu/recursos/transporte/EMT/lineasYHorarios/`:

| Dataset open-data | Archivo | Equivalente GTFS |
|---|---|---|
| `lineas-y-horarios-bus-rutas` | `routes.csv` | `routes.txt` |
| `lineas-y-horarios-bus-servicios` | `trips.csv` | `trips.txt` |
| `lineas-y-horarios-bus-horario` | `stop_times.csv` | `stop_times.txt` |
| `linea-bus-formas` | `shapes.csv` | `shapes.txt` |
| `linea-bus-excepciones` | `calendar_dates.csv` | `calendar_dates.txt` |

Aporta recorridos ordenados, horarios teóricos y geometría de las líneas
(`shapes`). `route_id` = `codLinea` de las demás fuentes → clave de join.

Existe también un GTFS oficial servido por el NAP/MITRAMS (vía Transit.land o
`nap.transportes.gob.es`), pero requiere token y arrastra una atribución obligatoria
("Powered by MITRAMS"). **Se prefiere el GTFS del portal de Málaga** por ser abierto,
sin token y bajo la misma licencia que el resto.

#### 3. Líneas y paradas (JSON propietario)

Dataset: `lineas-y-paradas-autobuses-emt`.

- `https://datosabiertos.malaga.eu/recursos/transporte/EMT/EMTLineasYParadas/lineasyparadas.geojson`

Pese al nombre, **no es GeoJSON ni FIWARE**: es un array JSON propietario de la EMT
con líneas (`codLinea`, `nombreLinea`, cabeceras) y sus paradas ordenadas
(`codParada`, `nombreParada`, `latitud`, `longitud`, `sentido`, `orden`). Aquí las
coordenadas sí son numéricas. Útil como fuente de nombres de parada legibles y para
validar los recorridos del GTFS.

#### 4. Estimaciones oficiales de llegada (scraping de referencia)

La web móvil de la EMT muestra los minutos de espera por parada:

- `https://www.emtmalaga.es/emt-mobile/informacionParada.html?codParada=<cod>`

Los tiempos los **renderiza el servidor directamente en el HTML** (no hay API
JSON): cada línea que para es un `<li>` con el número de línea, el destino y un
`<span class="minutosN">N min.</span>`. No forma parte del portal de datos abiertos
(es la web de la EMT), por lo que se usa **solo como baseline de referencia** para
calibrar y validar el estimador propio, no como dependencia de producción. Hay que
filtrar valores centinela anómalos (p. ej. `785 min.`).

#### 5. Contexto de tráfico (fase 2)

Datasets de tráfico del portal, disponibles en CSV/GeoJSON/GML/KML/SHP:

- `cortes-de-trafico` — **el más relevante**: un corte sobre el recorrido de una
  línea explica retrasos/desvíos y permite avisar al usuario. Candidato a entrar en
  el modelo de estimación en fase 2.
- `paneles-de-mensajes-variables` — incidencias oficiales, capa informativa
  secundaria.
- `camaras-de-trafico` — solo ubicaciones, sin aforo ni streaming; valor marginal.
- `semaforos` — **descartado**: solo geolocaliza los semáforos, sin estado de ciclo
  en tiempo real, por lo que no es modelable para estimación.

#### Display

Mapa con **Leaflet + teselas de OpenStreetMap**, siguiendo el patrón de referencia
de [AlejandroFuster/MapaEMT](https://github.com/AlejandroFuster/MapaEMT) (Leaflet +
`L.geoJson`), pero modernizado (sin jQuery `async:false`) y con la lógica de
estimación añadida.

### Arquitectura de datos

Las fuentes se combinan en un modelo híbrido. El formato de **origen viene impuesto**
por la EMT (FIWARE y JSON propietario, ambos mal etiquetados como `.geojson`); el
backend **normaliza** todo a un modelo interno coherente y expone al frontend
**GeoJSON canónico** (`FeatureCollection`, coordenadas numéricas en orden `[lon, lat]`).

```
ESTÁTICO (descarga diaria)        TIEMPO REAL (polling 1 min)       REFERENCIA (scrape puntual)
  GTFS CSV open-data Málaga         posiciones buses (open-data)      informacionParada.html
  (routes/trips/stop_times/          + cortes-de-trafico (fase 2)      (minutos oficiales EMT)
   shapes/calendar_dates)                   │                                 │
        │                                   │                                 │
        └─────────────┬─────────────────────┴─────────────────────────────────┘
                      ▼
        Backend: map-matching (bus → shape) + ETA propio,
        ajustado por cortes de tráfico (fase 2), calibrado
        contra los minutos oficiales (scrape) como baseline
                      ▼
        GeoJSON FeatureCollection  ──►  Leaflet + OSM
```

### Estrategia de estimación de llegada

No existe GTFS-Realtime ni ninguna API de ETA abierta de la EMT: solo hay posiciones
vivas (1 min) y horarios teóricos (GTFS). Las estimaciones oficiales existen pero
solo en HTML renderizado. Por tanto, **la estimación se construye a medida**, que es
el principal punto donde esta app busca superar a la oficial.

Enfoque híbrido:

1. **Base GTFS** — del GTFS se obtiene el recorrido ordenado de cada línea y su
   geometría (`shapes`), más el horario teórico (`stop_times`).
2. **Corrección con posición real** — se proyecta la posición del bus (map-matching)
   sobre la polilínea del recorrido de su línea; se estima velocidad comparando
   capturas consecutivas (o con `last_update`); se calcula la distancia a lo largo
   del shape hasta cada parada siguiente → ETA.
3. **Ajuste por incidencias (fase 2)** — los cortes de tráfico sobre el recorrido
   permiten marcar posibles retrasos/desvíos.
4. **Calibración** — los minutos oficiales (scraping de `informacionParada.html`) se
   usan como verdad de referencia para validar y afinar el estimador, no como fuente
   de producción.

Limitaciones conocidas:

- El refresco de 1 minuto acota la precisión del ETA; entre capturas la posición del
  bus "salta". Para el display puede interpolarse la posición a lo largo del shape.
- Ninguna fuente de posiciones trae velocidad ni rumbo por vehículo; hay que
  inferirlos comparando capturas consecutivas con el `last_update` del CSV.
- No se conoce el método interno con que la EMT calcula sus minutos oficiales (GPS
  vivo vs. interpolación de horario); conviene muestrear una parada en el tiempo para
  caracterizarlo antes de confiar en él como baseline.

### Despliegue y arquitectura técnica

Objetivo: **coste cero**, desplegado en Vercel (plan Hobby) con Supabase (plan Free)
como base de datos PostgreSQL.

#### Stack

- **Frontend + API**: Next.js (App Router) en **Vercel Hobby**. Mapa con Leaflet +
  OSM en el cliente; rutas `/api/*` como funciones serverless que leen de Supabase y
  devuelven GeoJSON.
- **Base de datos**: **Supabase Postgres** con la extensión **PostGIS** para la
  geometría de los `shapes` y los cálculos de distancia / map-matching en SQL.
- **Ingesta y tareas programadas**: **`pg_cron` + `pg_net` dentro de Supabase** (no
  en Vercel, ver más abajo).

#### Dónde vive el polling de 1 minuto (decisión clave)

Vercel es serverless: no hay un proceso permanente que haga polling. Además, el
**cron de Vercel Hobby está limitado a una ejecución diaria**, por lo que **no puede**
leer el CSV de la EMT cada minuto. Verificado en la documentación de Vercel (2026).

Por tanto, la ingesta periódica **vive en Supabase**:

- Un job de **`pg_cron` cada minuto** ejecuta, vía **`pg_net`**, una petición HTTP al
  CSV de posiciones de la EMT e inserta las filas en una tabla de posiciones.
- Un job de **`pg_cron` diario** recarga el GTFS (CSV del portal) a sus tablas.
- Un job de **`pg_cron`** periódico **purga** las posiciones crudas antiguas.

Vercel queda así como capa de presentación/lectura; toda la lógica de recolección
reside en la base de datos. Alternativas si se prefiere sacar el cron de Supabase:
GitHub Actions programado (gratis, pero puntualidad no garantizada) o un cron externo
(p. ej. cron-job.org) golpeando un endpoint `/api/ingest`.

#### Gestión del límite de 500 MB (Supabase Free)

A ~83 buses × 1 captura/min ≈ **120 000 filas/día**, guardar posiciones crudas de
forma indefinida agota el medio giga del plan Free en semanas. Estrategia:

- Retener solo una **ventana corta** de posiciones crudas (p. ej. 2–6 h), suficiente
  para estimar velocidad y ETA.
- Purgar lo más antiguo con un `pg_cron` periódico (`DELETE` + `VACUUM`).
- Para el histórico orientado a aprender tiempos por tramo (fase 2), almacenar datos
  **agregados** (medias por tramo/franja horaria), nunca crudos.

#### Riesgo: pausado por inactividad

Los proyectos de Supabase Free **se pausan tras ~1 semana de inactividad**, lo que
detendría el cron de ingesta. El propio `pg_cron` ejecutándose cada minuto debería
contar como actividad y mantener el proyecto vivo; conviene verificarlo en la práctica
y, si no basta, añadir un ping externo periódico.

#### Modelo de datos (borrador)

- Tablas GTFS: `routes`, `trips`, `stop_times`, `stops`, `shapes`, `calendar_dates`
  (recargadas a diario).
- `bus_positions` — posiciones crudas con `last_update` (ventana corta, purgada).
- `shapes` con geometría PostGIS (`LINESTRING`) para map-matching.
- (Fase 2) `segment_times` — tiempos agregados por tramo y franja horaria.

