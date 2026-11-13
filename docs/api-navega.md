# API Navega (EMT Málaga)

Mapa no oficial de `https://navega.emtmalaga.es/api/`, la API que usa el front
"Líneas y Horarios" de la EMT.

- **Fecha del sondeo:** 2026-11-13.
- **Origen:** no existe documentación pública (ni Swagger ni OpenAPI). Los
  endpoints y parámetros salen del bundle del front
  (`https://navega.emtmalaga.es/js/main.*.js`, cliente `0.25.1`) y cada uno se
  comprobó con una petición GET real.
- **Estabilidad:** la propia página `/api/` avisa de que "la API se encuentra
  actualmente en desarrollo y no es estable para uso real". Puede cambiar sin
  aviso: conviene aislarla tras un adaptador y validar la forma de las
  respuestas.

## Generalidades

| Aspecto | Valor |
|---|---|
| Base | `https://navega.emtmalaga.es/api/` |
| Método | solo `GET` |
| Autenticación | ninguna |
| Formato | `application/json; charset=utf-8` |
| Versión de cliente | `v=0.25.1` lo añade el front a toda petición; es opcional |
| CORS | sin cabeceras `Access-Control-*`: solo uso desde servidor |
| Caché | `Cache-Control: max-age=…` y `ETag` por endpoint (ver tabla) |
| Timeout del front | 10 s |

### TLS: falta el certificado intermedio

El servidor solo envía el certificado hoja (`*.emtmalaga.es`) y omite el
intermedio `GeoTrust TLS RSA CA G1`. Los navegadores lo descargan solos, pero
`curl` y `fetch` de Node fallan con
`unable to get local issuer certificate`.

Solución: descargar el intermedio y añadirlo a la confianza del proceso. No
desactivar la verificación TLS.

```bash
curl -s http://cacerts.geotrust.com/GeoTrustTLSRSACAG1.crt | openssl x509 -inform DER -out geotrust-g1.pem
```

```bash
NODE_EXTRA_CA_CERTS=./geotrust-g1.pem node script.js
```

Huella SHA-256 del intermedio en la fecha del sondeo:
`C0:6E:30:7F:7C:FC:1D:32:FA:72:A4:C0:33:C8:7B:90:01:9A:F2:16:F0:77:5D:64:97:8A:2E:CA:6C:8A:23:0E`.

### Fechas

| Parámetro | Formato | Ejemplo |
|---|---|---|
| `day` | `DD-MM-YYYY` (jornada de servicio) | `13-11-2026` |
| `date` | `DD-MM-YYYY+HH:MM`, con `+` literal (`%2B` en la URL) | `13-11-2026%2B10:30` |
| `vis` | ISO 8601 UTC | `2026-11-13T09:30:00.000Z` |

La jornada cambia a las 04:30: antes de esa hora el front envía el día
anterior. El formato ISO en `day` (`2026-11-13`) devuelve 400.

Las respuestas usan ISO 8601 con desfase (`2026-11-13T06:20:00+01:00`), salvo
`estimaciones`, que lo da sin dos puntos (`+0100`).

### Errores

Los errores devuelven una página HTML, no JSON.

| Código | Cuándo |
|---|---|
| 400 | falta un parámetro obligatorio o el formato es inválido |
| 404 | ruta inexistente |
| 500 | visto en `rutas` sin `routeId` |
| 429 | el front lo interpreta como cuota agotada; umbral desconocido |

El front trata 404, 409, 410 y 505 como "API incompatible" (cliente
desactualizado).

### Identificadores

- `codPar`: código público de parada (el del poste).
- `nodeId` / `nodeCode` / `num`: nodo interno de la red. `paradas` da la
  equivalencia `nodeId` ↔ `codPar`.
- `lineId` → `config` → `sublineId` → `routeId`: jerarquía de la topología.
  Una línea tiene varias configuraciones; solo una está activa cada jornada
  (ver `rutasActivas`).
- `direction`: 1 ida, 2 vuelta, 3 circular. Para las circulares,
  `parametros.sentidoCirculares` indica por línea 1 = horario,
  2 = antihorario.

## Endpoints

| Endpoint | Parámetros | `max-age` | Contenido |
|---|---|---|---|
| `parametros` | — | 60 s | versión de topología y ajustes globales |
| `lineas` | — | ~15 h | líneas, configuraciones, sublíneas y rutas |
| `paradas` | — | ~15 h | paradas con coordenadas y conexiones |
| `rutas` | `routeId` (lista) | ~15 h | nodos y geometría de cada ruta |
| `buses_servicios` | `lineId` (lista) | 10 s | posición y estado de los buses en servicio |
| `estimaciones` | `codPar` (lista) | 10 s | llegadas estimadas a paradas |
| `horario` | `day`, `date`, `lineId` (lista) | 4 s | viajes planificados de la jornada |
| `rutasActivas` | `day` | 0 | rutas en servicio en la jornada |
| `rutasPrevistas` | `day` | — | rutas planificadas para un rango de jornadas |
| `desvios` | — | 0 | desvíos activos |
| `avisos` | — | 180 s | avisos al viajero |
| `puntosVenta` | — | — | puntos de venta y recarga |
| `visualizacion` | `vis` | — | textos y orden de líneas para la interfaz |

Las listas van separadas por comas: `lineId=1,19`.

### `parametros`

```json
{
  "topologiaDisponible": "2026.11.13.01",
  "visualizacionDisponible": "2026-11-05T10:32:48+01:00",
  "lineasOcultas": [0, 49, 88],
  "sentidoCirculares": { "29": 2, "42": 2, "62": 2, "71": 1 },
  "ft-pictogramas": "parada",
  "versionTopologia": "undefined",
  "versionRed": "undefined"
}
```

`topologiaDisponible` sirve para saber cuándo refrescar `lineas`, `paradas` y
`rutas`.

### `lineas`

83 líneas en la fecha del sondeo.

```json
{
  "lineas": [
    {
      "lineId": 1,
      "lineLabel": "1",
      "name": "Parque del Sur - Alameda Principal - San Andrés",
      "attributes": 800,
      "configs": [
        {
          "config": 1,
          "sublines": [
            {
              "order": 1,
              "sublineId": 1,
              "sublineLabel": "1",
              "name": "Parque del Sur - San Andrés",
              "routes": [
                {
                  "routeId": 11,
                  "routeConfig": 1,
                  "name": "Parque del Sur - San Andrés",
                  "destination": "San Andrés",
                  "direction": 1,
                  "modified": "2026-10-07T10:58:28Z"
                }
              ]
            }
          ]
        }
      ]
    }
  ],
  "topologia": null
}
```

### `paradas`

1204 paradas, unos 750 KB.

```json
{
  "paradas": [
    {
      "nodeId": 1511,
      "codPar": 1,
      "name": "Feria",
      "lat": 36.700283,
      "lon": -4.459203,
      "conexiones": [
        { "lineId": 238, "config": 1, "sublineId": 226, "routeId": 2381, "attributes": 2 }
      ]
    }
  ],
  "topologia": null
}
```

### `rutas?routeId=11,12`

Devuelve un array (sin objeto envolvente). `routeId` es obligatorio: sin él
responde 500.

```json
[
  {
    "lineId": 1,
    "routeId": 11,
    "routeConfig": 1,
    "length": 9600,
    "modified": "2026-10-07T10:58:28Z",
    "name": "Parque del Sur - San Andrés",
    "destination": "San Andrés",
    "direction": 1,
    "nodes": [
      { "position": 0, "type": 1, "nodeCode": 152, "attributes": 1 },
      { "position": 306, "type": 1, "nodeCode": 153, "attributes": 0 }
    ],
    "polyline": "je|lG}phaeAvB]vGk@…"
  }
]
```

- `length` y `nodes[].position`: metros desde el inicio de la ruta.
- `nodes[].nodeCode`: es el `codPar` público de la parada, no el `nodeId`
  interno de `paradas` (comprobado: los 7603 nodos de las 304 rutas existen
  como `codPar`).
- `polyline`: algoritmo de Google Encoded Polyline con **6 decimales** y con
  **la longitud antes que la latitud** en cada par (el estándar es latitud,
  longitud). Comprobado: decodificado así, las 2545 paradas de las 89 rutas
  planificadas quedan a menos de 20 m de su recorrido (mediana 5 m).
- Rendimiento: las 93 rutas planificadas responden en 0,3 s; las 304 de toda
  la red tardaron 47 s (las que no operan no están en caché del servidor).

### `buses_servicios?lineId=1,19`

`lineId` es obligatorio (400 sin él), pero admite todas las líneas en una sola
petición: con las 83 devolvió 190 buses de 39 líneas, 81 KB en 0,24 s.

```json
{
  "buses": [
    {
      "lineId": 1,
      "carId": 1,
      "currentLineId": 1,
      "sublineId": 303,
      "routeId": 14,
      "currentRouteId": 14,
      "serviceId": { "date": "2026-11-13", "service": "001-01", "day": "V" },
      "serviceStatus": 0,
      "serviceRouteIds": [14, 12, 14, 12],
      "vehicleId": 676,
      "plate": "4297JWC",
      "vehicleStatus": 0,
      "vehicleAlarm": 83886081,
      "vehicleLocationStatus": 5,
      "vehiclePosition": { "lat": 36.729754, "lng": -4.420353 },
      "lastNode": { "type": 1, "num": 156 },
      "nextNode": { "type": 1, "num": 157 }
    }
  ]
}
```

- `serviceId.service`: `LLL-CC` (línea y coche), igual que `blockId` en
  `horario` y `serviceId` en `estimaciones`.
- `serviceId.day`: tipo de día (`V` = viernes).
- La posición usa `lng`; `paradas` usa `lon`.
- `vehicleId` es el `codBus` del CSV de datos abiertos (177 de 177 buses del
  CSV casan), y `lineId` su `codLinea`.
- No hay marca temporal por vehículo (el CSV traía `last_update`).
- Sentido: sale del `direction` de la ruta actual (`currentRouteId`). El CSV
  publica `sentido` 1 para `direction` 1 y 3 (circulares) y 2 para 2.
- El CSV solo incluye buses localizados en línea; aquí llegan además los
  deslocalizados, en cocheras, incorporándose, etc. (13 más en la muestra).

### `estimaciones?codPar=1,2552`

`codPar` es obligatorio (400 sin él).

```json
{
  "codPar": [1, 2552],
  "estimaciones": [
    {
      "jnyLineOrder": 4,
      "routeId": 192,
      "vehicleId": 689,
      "type": 0,
      "flags": 0,
      "arrival": 156,
      "wait": 0,
      "distance": 385,
      "delay": 0,
      "destinationCode": null,
      "destinationName": "Paseo del Parque",
      "detourId": 0,
      "panelMessage": null,
      "serviceId": "019-05",
      "schedGap": -19,
      "line": {
        "label": 19,
        "name": "Paseo del Parque - Campanillas - Maqueda (Por O. Gasset)",
        "id": 19,
        "subline": { "id": 2212, "order": 1, "name": "Paseo del Parque - Maqueda", "label": 19 }
      },
      "codPar": 2552,
      "car": 5,
      "direction": 2,
      "arrivalTime": "2026-11-13T10:27:29+0100",
      "departureTime": "2026-11-13T10:27:30+0100"
    }
  ],
  "exclusiones": [],
  "tiempo": "2026-11-13T10:25:23+01:00"
}
```

- `arrival`: sin determinar; no coincide con `arrivalTime − tiempo`. Para la
  hora de llegada usar `arrivalTime` o `departureTime`, que es lo que hace
  la web (ver "Enumerados y máscaras de bits").
- `type` y `flags`: ver "Enumerados y máscaras de bits".
- `distance`: aparentemente metros hasta la parada.
- `vehicleId` enlaza con `buses_servicios`.

### `horario?day=13-11-2026&date=13-11-2026%2B10:30&lineId=1`

Los tres parámetros son obligatorios. Para la línea 1 devolvió 202 viajes
(80 KB).

```json
{
  "date": "13-11-2026",
  "lineId": [1],
  "exclusions": [],
  "timetable": [
    {
      "blockId": "001-01",
      "tripId": 2,
      "tripOrder": 2,
      "lineId": 1,
      "sublineId": 303,
      "routeId": 14,
      "direction": 1,
      "lineVehicle": 1,
      "vehicle": null,
      "status": null,
      "events": [
        { "nodeId": 152, "event": 11, "instant": 22800, "theoricTime": "2026-11-13T06:20:00+01:00", "referenceTime": null, "status": null },
        { "nodeId": 172, "event": 4, "instant": 25200, "theoricTime": "2026-11-13T07:00:00+01:00", "referenceTime": null, "status": null }
      ]
    }
  ],
  "currentTime": "2026-11-13T10:25:49+01:00"
}
```

- `instant`: segundos desde la medianoche de la jornada (22800 = 06:20).
- Cada viaje trae solo dos eventos (salida y llegada a cabecera), no el paso
  por cada parada.

### `rutasActivas?day=13-11-2026`

Objetos indexados por id, no arrays.

```json
{
  "jornada": "13-11-2026",
  "lineas": {
    "1": {
      "linea": 1,
      "sublineas": {
        "303": {
          "sublinea": 303,
          "config": 3,
          "rutas": {
            "12": {
              "ruta": 12,
              "primerasalida": "2026-11-13T06:30:00+01:00",
              "ultimasalida": "2026-11-14T00:00:00+01:00",
              "ultimaretirada": "2026-11-14T00:30:00+01:00"
            }
          }
        }
      }
    }
  }
}
```

Si `lineas` viene vacío, el front lo trata como "jornada no disponible".

### `rutasPrevistas?day=13-11-2026`

Misma estructura que `rutasActivas`, sin horas, y con el rango de validez:

```json
{
  "jornadaInicio": "06-11-2026",
  "jornadaFin": "27-11-2026",
  "lineas": { "1": { "linea": 1, "sublineas": { "303": { "sublinea": 303, "config": 3, "rutas": { "12": { "ruta": 12 } } } } } }
}
```

### `desvios`

```json
{
  "desvios": [
    {
      "id": 4067,
      "etiqueta": "Desvío Caparros 2",
      "flags": 65,
      "linea": 2,
      "sublinea": 2265,
      "rutaini": 25,
      "nodoini": 261,
      "rutafin": 24,
      "nodofin": 229,
      "mensaje_desviadas": null,
      "mensaje_previas": null
    }
  ]
}
```

### `avisos`

```json
{
  "avisos": [
    {
      "id": 13880,
      "fechainicio": "2023-12-18T00:00:00+01:00",
      "fechafin": "2026-12-31T23:59:59+01:00",
      "lineas": [19, 25],
      "paradas": [2552, 2571],
      "titulo": "L-19 y 25: Desvío por Rastro Maqueda",
      "texto": "…",
      "url": null
    }
  ]
}
```

`paradas` parece contener `codPar` (2552 responde como tal en `estimaciones`).

### `puntosVenta`

131 puntos.

```json
{ "puntosVenta": [ { "id": 1, "domicilio": "C/ Silencio, 22 Local A", "tipo": 1, "latitud": 36.667202, "longitud": -4.503388 } ] }
```

### `visualizacion?vis=2026-11-13T09:30:00.000Z`

Ajustes de presentación del front: etiquetas por línea y orden de listado.

```json
{
  "textos": [ { "id": 2, "tipo": 5, "texto": "Refuerzo especial", "icono": null, "color": "neutral", "lineas": [12, 13, 16] } ],
  "orden": [ { "orden": 10, "linea": 1 } ],
  "generado": "2026-11-13T10:24:57+01:00"
}
```

## Recursos estáticos relacionados

Aparecen en el bundle; no se han sondeado.

- `https://navega.emtmalaga.es/fotosParadas/<codPar>.jpg`: foto de la parada.
- `https://navega.emtmalaga.es/edipa/pictogramas/1/<id>`: pictogramas.
- `https://navega.emtmalaga.es/img/esquemas/<…>.svg`: esquemas de línea.
- Prefijo `/pre`: aparenta ser un entorno de preproducción.

## Enumerados y máscaras de bits

Nombres tomados de las constantes del bundle del front (cliente `0.25.1`) y
contrastados con dos capturas reales de `buses_servicios` (190 buses cada
una) y una de cada otro endpoint. Los nombres son los del front; su
significado operativo exacto no está documentado por la EMT.

Los campos marcados como "máscara" combinan valores con OR: el front los
convierte en un objeto de booleanos con `valor & bit`.

### `buses_servicios`

**`vehicleLocationStatus`** (enumerado):

| Valor | Nombre | Icono en la web |
|---|---|---|
| 0 | `NO_DEFINIDO` | oculto |
| 1 | `NO_ASIGNADO` | oculto |
| 2 | `ASIGNADO` | oculto |
| 3 | `INCORPORACION` | oculto |
| 4 | `RETIRADA` | oculto |
| 5 | `LOCALIZADO_LINEA` | bus según sentido (ida, vuelta, circular) |
| 6 | `FUERA_LINEA` | deslocalizado |
| 7 | `DESLOCALIZADO` | deslocalizado |
| 8 | `RECORRIDO_VACIO` | sin subida de viajeros |
| 9 | `DESVIO` | bus con alerta |
| 10 | `AVERIA_SENSORES` | deslocalizado |
| 11 | `LOCALIZADO_COCHERAS` | oculto |
| 12 | `ESPERA_CABECERA` | en cabecera |
| 13 | `FUERA_RUTA` | deslocalizado |
| 14 | `ASIGNADO_MANUAL` | neutro |

Con valor 5 o 9 la web además oculta el bus si `lineId != currentLineId`, y
con valor 5 también si `currentRouteId` es `null`. Observado: 5 en ~93 % de
los buses, 7 en ~6 %.

**`vehicleStatus`** (máscara):

| Bit | Valor | Nombre | Visto |
|---|---|---|---|
| 5 | 32 | `EN_DESVIO` | sí |
| 7 | 128 | `ULTIMA_VUELTA` | sí |
| 13 | 8192 | `ALCANCE` | sí |
| 14 | 16384 | `SIN_COMUNICACION` | sí |
| 24 | 16777216 | `EN_COCHERA` | sí |
| 29 | 536870912 | `AVERIADO` | sí |

- La web solo usa `EN_DESVIO` (pinta el bus con alerta).
- `AVERIADO` aparece en ~10 % de los buses, casi todos localizados en línea
  y en servicio, así que no parece significar "bus parado por avería".
- 7 de los 11 buses con `vehicleLocationStatus = 7` tenían
  `SIN_COMUNICACION`.
- Bits presentes en los datos y sin nombre en el front: 4 (16), 11 (2048),
  23 (8388608, entre el 10 y el 15 % de los buses), 31, 32 y 34. Para los
  bits 23 y 31 hay hipótesis en "Hipótesis sobre campos sin leyenda".

**`serviceStatus`**: el front solo define `NINGUNO = 0`. Vistos además 128,
256 y 512; ver "Hipótesis sobre campos sin leyenda".

**`vehicleAlarm`**: máscara que el front copia sin interpretar. Bits vistos:
24 (en ~97 % de los buses), 0, 4, 5, 26, 21, 22, 1, 3. Sin leyenda; ver
"Hipótesis sobre campos sin leyenda".

**`lastNode.type` / `nextNode.type`**: 1 = `PARADA` (único valor definido).
Solo entonces `num` es un código de parada.

### `estimaciones`

**`type`** (máscara):

| Valor | Nombre |
|---|---|
| 0 | `NORMAL` |
| 1 | `TEORICA` |
| 4 | `INCORPORACION` |

`TEORICA` indica que la hora sale del horario planificado, no de un bus
localizado: en la muestra llegaba con `vehicleId = 0`. La web la marca con
un icono propio.

**`flags`** (máscara):

| Bit | Valor | Nombre |
|---|---|---|
| — | 0 | `PASO` |
| 10 | 1024 | `SALIDA` |
| 11 | 2048 | `LLEGADA` |
| 18 | 262144 | `SIN_LLEGADA` |
| 20 | 1048576 | `ULTIMO_VIAJE` |
| 22 | 4194304 | `DESVIO` |
| 24 | 16777216 | `HA_LLEGADO` |

Visto: 0 y 1048576 (último viaje del día, junto con `type = 1`).

**Otros campos:**

- `detourId`: distinto de 0 si la estimación está afectada por un desvío. La
  web muestra aviso de desvío si `flags.DESVIO` o `detourId != 0`, con el
  texto de `panelMessage`.
- `departureTime`: es el campo que usa la web para la cuenta atrás. Calcula
  `departureTime − ahora`, corregido con el desfase entre el reloj local y
  `tiempo`; muestra "Ahora" si es negativo, minutos hasta 40 y la hora a
  partir de ahí.
- `arrival`: el front no lo usa. No coincide con `arrivalTime − tiempo`
  (156 frente a 126 s, 917 frente a 829 s…), sin desfase constante. No es
  una cuenta atrás; ver "Hipótesis sobre campos sin leyenda".
- `schedGap`, `delay`, `wait`, `jnyLineOrder`, `distance`: el front los
  copia y no los usa. Sin leyenda oficial; para `delay`, `jnyLineOrder` y
  `schedGap` hay inferencias sólidas en "Hipótesis sobre campos sin
  leyenda".
- `exclusionId`, `excludedArrivalTime`, `excludedDepartureTime`: opcionales;
  enlazan la estimación con elementos de `exclusiones`.

**`exclusiones[]`**: campos `exclusion` (id), `action`, `direction`,
`nodeId`, `startTime`, `endTime`, `text_es`, `text_en`, `link_es`,
`link_en`. La muestra venía vacía. Valores de `action`:

| Valor | Nombre |
|---|---|
| 11 | `QUITAR_SALIDAS_AFECTADAS` |
| 12 | `QUITAR_SALIDAS_TODAS` |
| 13 | `SOLO_PRIMERAS_SALIDAS` |
| 21 | `QUITAR_ESTIMACIONES` |
| 30 | `OCULTAR_TODO` |
| 31 | `NO_CIRCULA` |
| 32 | `SUPRESION` |

### `horario`

**`events[].event`** (máscara):

| Valor | Nombre |
|---|---|
| 0 | `PASO` |
| 1 | `REGULACION` |
| 2 | `INICIO_VIAJE` |
| 4 | `FIN_VIAJE` |
| 8 | `ENSAL_LINEA` |
| 16 | `ENSAL_COCHERA` |

Valores vistos, descompuestos:

| Valor | Composición |
|---|---|
| 3 | `REGULACION` + `INICIO_VIAJE` |
| 4 | `FIN_VIAJE` |
| 11 | `REGULACION` + `INICIO_VIAJE` + `ENSAL_LINEA` |
| 12 | `FIN_VIAJE` + `ENSAL_LINEA` |

`ENSAL_LINEA` aparenta marcar el primer y el último viaje de cada coche
(entrada o salida de línea): 17 eventos de cada tipo en la línea 1.

**`timetable[].status`** (máscara; `null` en toda la muestra):

| Valor | Nombre |
|---|---|
| 1 | `PLANIFICADO` |
| 2 | `SUSTITUIDO` |
| 4 | `SUSTITUYENTE` |
| 8 | `ENVIADO` |
| 16 | `CANCELADO` |
| 64 | `MODIFICADO_NO_GUARDADO` |
| 128 | `HORARIO_TEORICO_MODIFICADO` |
| 256 | `NO_DISPONIBLE` |
| 512 | `EN_VACIO` |
| 1024 | `LIMITADO` |
| 2048 | `PARCIAL` |
| 4096 | `RECORRIDO_GUARDADO` |
| 8192 | `HORARIO_REAL_MODIFICADO` |
| 32768 | `CON_NO_CARGAR` |
| 65536 | `CANCELADO_PARCIAL` |
| 131072 | `PARCIAL_AÑADIDO` |
| 262144 | `SUSTITUYENTE_NO_PLANIFICADO` |

**`events[].status`** (máscara; `null` en toda la muestra):

| Valor | Nombre |
|---|---|
| 1 | `EJ_LLEGADA` |
| 2 | `EJ_SALIDA` |
| 4 | `PASADO` |
| 16 | `CANCELADO` |
| 32 | `MODIFICADO` |
| 64 | `PASO_GENERADO` |
| 256 | `MODIFICADO_REGULACION_VACIO` |
| 512 | `MODIFICADO_REGULACION_LIMITADO` |
| 1024 | `MODIFICADO_PERDIDA_VUELTA` |
| 2048 | `AÑADIR_VIAJE` |
| 4096 | `NO_DISPONIBLE` |
| 8192 | `ESTIMADO_ACUMULACION` |
| 16384 | `EXCLUIDO` |
| 32768 | `IGNORADO` |
| 524288 | `ULTIMO_VIAJE` |
| 1048576 | `APORTADOR_CORRESPONDENCIA` |
| 2097152 | `RECEPTOR_CORRESPONDENCIA` |
| 4194304 | `EN_DESVIO` |

### `desvios`

**`flags`** (máscara):

| Valor | Nombre |
|---|---|
| 1 | `ACTIVO` |
| 4 | `LIMITACION` |
| 8 | `PARCIAL` |
| 16 | `REGULACION` |
| 32 | `REGULACION_INICIO` |
| 64 | `REGULACION_FIN` |
| 128 | `DESACTIVACION_DISPLAYS` |
| 256 | `ACTIVACION_PERIFERICOS` |

Visto: 65 en los cinco desvíos = `ACTIVO` + `REGULACION_FIN`.

### Topología

**`attributes`** en `rutas[].nodes[]` y `paradas[].conexiones[]`
(enumerado):

| Valor | Nombre |
|---|---|
| 0 | `PASO` |
| 1 | `ORIGEN` |
| 2 | `DESTINO` |

Origen y destino son las cabeceras de la ruta. La web no ofrece salidas
desde un nodo `DESTINO`.

**`type`** en `rutas[].nodes[]`: 1 = `PARADA` (único valor definido).

**`attributes`** en `lineas[]`: el front lo copia sin interpretar. Vistos
800 (45 líneas), 0 (35) y 32 (3). Sin leyenda; parece separar líneas
regulares de variantes y servicios especiales (ver "Hipótesis sobre campos
sin leyenda").

**`parametros.lineasOcultas`**: líneas que la web no lista, salvo con el
ajuste interno `verLineasOcultas` activado.

### `puntosVenta`

**`tipo`** (enumerado):

| Valor | Nombre |
|---|---|
| 1 | `ESTANCO` |
| 2 | `KIOSKO` |
| 3 | `PAPELERIA` |
| 4 | `LOTERIA` |
| 5 | `LIBRERIA` |
| 6 | `TIENDA_ELECTRONICA` |
| 9 | `POSTE_SIRE` |
| 10 | `CAC` (Centro de Atención al Cliente) |

### `visualizacion`

**`textos[].tipo`** (enumerado):

| Valor | Nombre | Ámbito |
|---|---|---|
| 1 | `RECORRIDO_ALTERNATIVO` | línea (`lineas[]`) |
| 2 | `MULTIPLES_RECORRIDOS` | línea |
| 3 | `LINEA_INACTIVA` | línea |
| 4 | `RUTA_INACTIVA` | ruta (`rutas[]`) |
| 5 | `SERVICIO_ESPECIAL` | línea |
| 6 | `SERVICIO_FINALIZADO_LINEA` | línea |
| 7 | `SERVICIO_FINALIZADO_RUTA` | ruta |

## Hipótesis sobre campos sin leyenda

El front no interpreta estos campos, así que no hay nombres oficiales. Lo
que sigue son inferencias estadísticas sobre capturas del 2026-11-13: 11
capturas de `buses_servicios` por la mañana (10:25–10:45) y 4 por la tarde
(15:27–15:28), unas 190 buses cada una; 4 capturas de `estimaciones` (unas
540 filas cada una) y el `horario` de 9 líneas. Un solo día, viernes
laborable: tratar como hipótesis, no como especificación.

Nivel de evidencia: **fuerte** = la relación se cumple en todas o casi
todas las filas; **media** = patrón claro con excepciones o muestra corta;
**débil** = indicio.

### `estimaciones`

| Campo | Hipótesis | Evidencia |
|---|---|---|
| `delay` | Segundos que el bus permanece en la parada: `departureTime − arrivalTime − 1`. | Fuerte: exacto en 544 de 544 filas. Los valores altos (hasta 773 s) salen en cabeceras: es el tiempo de regulación. |
| `jnyLineOrder` | Número de viaje dentro del servicio del coche: `horario.timetable[].tripOrder − 1`. | Fuerte: 176 de 176 filas cruzadas con `horario`. |
| `schedGap` | Segundos de adelanto respecto al horario teórico: teórica − estimada. Negativo = retraso. | Fuerte en cabecera: 6 de 6 salidas cuadran con `theoricTime − departureTime` con 2 s de margen. En paradas intermedias no se puede comprobar, porque `horario` no da pasos intermedios. |
| `arrival` | Segundos hasta la llegada contados desde un instante anterior a `tiempo`, no una cuenta atrás viva. | Media: entre capturas a 21 s no cambia en el 81 % de las filas, igual que `arrivalTime`; las estimaciones se recalculan por evento del bus, no por reloj. Siempre supera a `arrivalTime − tiempo`: mediana de 80 a 110 s, y en torno a un 7 % más en horizontes de más de 5 minutos. La referencia exacta sigue sin identificar. |
| `wait` | — | Siempre 0 en todas las capturas. |
| `type = 3` | `TEORICA` más un bit 2 sin nombre. | Visto en 7 filas; sin indicio de qué añade. |

Confirmado además con datos: `flags.SALIDA` solo aparece en la primera
parada de la ruta, `flags.LLEGADA` solo en la última, y `flags.HA_LLEGADO`
va con `arrivalTime` ya pasado (bus detenido en la parada).

Consecuencia práctica: el retraso de un bus se puede leer directamente de
`schedGap` en su próxima parada. A media tarde la mediana era de −147 s.

### `buses_servicios.vehicleStatus`

| Bit | Hipótesis | Evidencia |
|---|---|---|
| 23 (8388608) | Bus detenido en parada, sobre todo regulando en cabecera. | Media-fuerte. Mañana: 92 % sin moverse en 12 s, 92 % a menos de 30 m de una parada, 75 % con `lastNode` = origen de la ruta (frente a 53 %, 35 % y 7 % sin el bit). Tarde: 47 % en origen o final frente a 5 %. |
| 14 `SIN_COMUNICACION` | El nombre del front encaja: posición congelada. | Fuerte: 100 % sin movimiento entre capturas. |
| 29 `AVERIADO` | Marca persistente de incidencia abierta en el vehículo; no implica que esté parado. | Media: fija por vehículo (19 buses la tuvieron en todas las capturas, 2 cambiaron), repartida por toda la flota, con buses circulando y en servicio normal. |
| 31 | Propiedad del vehículo (lote o equipo embarcado nuevo), no estado operativo. | Media: fija por vehículo; los 8 buses tienen las matrículas más recientes (`NJM`–`NRP`). |
| 11 (2048) | — | 3 buses, fijo por vehículo. Sin indicio. |
| 4, 32, 34 | — | Un vehículo cada uno. Sin indicio. |

### `buses_servicios.serviceStatus`

Es una máscara, no un enumerado: vistos 128, 256 y 512.

| Valor | Hipótesis | Evidencia |
|---|---|---|
| 128 | Última vuelta del servicio. | Fuerte: todos los buses vistos con 128 (7 por la mañana, 5 por la tarde) tenían también `vehicleStatus.ULTIMA_VUELTA`, casi todos con un único elemento en `serviceRouteIds`. En los 2 casos cruzados con `horario`, al bloque le quedaba ese viaje o uno más. |
| 512 | Bus incorporándose al servicio (en vacío). | Débil: un solo caso, con `vehicleLocationStatus = 3` (`INCORPORACION`), `lineId = 0` y sin ruta actual. |
| 256 | Sin hipótesis. | Estado transitorio: dura decenas de minutos, aparece y desaparece a mitad de ruta y afectaba al 23 % de los buses por la mañana y al 9 % por la tarde. Sin relación con posición en la ruta, movimiento, desvíos, línea, antigüedad del bus ni tiempo de descanso en cabecera. La relación con el retraso es contradictoria entre mañana y tarde. |

### `buses_servicios.vehicleAlarm`

Ningún bit se relaciona con el movimiento ni con la cercanía a paradas.
Casi todos parecen describir el equipo embarcado, no el servicio:

| Bit | Hipótesis | Evidencia |
|---|---|---|
| 24 | Bit de línea base (equipo operativo o conectado). | Media: activo en ~97 % de la flota y fijo por vehículo. Los pocos buses sin él tienen el campo casi a cero. |
| 5 | Propio del equipo de los buses antiguos. | Media: fijo por vehículo; 12 de 13 buses con matrículas `C`–`G`. |
| 21 | Propio de un lote reciente. | Media: 11 buses, todos con matrículas recientes y la mayoría del lote `NJM`. |
| 0 | Relacionado con el equipo. | Débil: fijo por vehículo, más frecuente en buses nuevos (58 % en matrículas `N`, 24 % en `J`). |
| 4 | Señal transitoria de un sensor. | Débil: cambia rápido (4,5 % de los intervalos de 12 s) y es más frecuente en buses nuevos. Sin significado identificado. |
| 1, 3, 22, 26 | — | Pocos buses. Sin indicio. |

Para el mapa, `vehicleAlarm` se puede ignorar.

### `lineas[].attributes`

| Valor | Líneas | Hipótesis |
|---|---|---|
| 800 (bits 5, 8 y 9) | 45: numeradas, nocturnas `N`, circulares `C`, `E`, `A`. 44 activas ese día. | Línea regular de la red. |
| 32 (bit 5) | 3: `18`, `CC` (City Center - Comic Con), `L` (UMA - Ampliación Campus). | Línea publicada pero no regular (eventual o parcial). |
| 0 | 35: variantes (`1A`, `7B`, `20A`…), feria (`F-…`), `S.ESP.`, `49` "Personal", `M` Metrobús. Solo 1 activa. | Variantes y servicios especiales o internos. |

Evidencia media para la distinción regular / especial; el significado de
cada bit por separado es una suposición.

### Irregularidades de forma en `buses_servicios`

Observadas en torno al 5 % de los registros (buses deslocalizados, incorporándose
o retirándose). Conviene validarlas en la ingesta:

- `lastNode` y `nextNode` llegan como array vacío `[]`, no como `null`,
  cuando no se conocen.
- Pueden faltar claves enteras: `currentRouteId`, `lineId`, `sublineId`,
  `routeId` y `vehicleLocationStatus`.
- `lineId`, `sublineId` y `routeId` valen 0 en buses deslocalizados; la
  línea real solo se deduce de `serviceId.service` (`LLL-CC`).
- `vehiclePosition` puede ser `{ "lat": null, "lng": null }`.
- `serviceId.service` no es siempre numérico: vistos `004-0A` y `020-1A`.
- `serviceRouteIds` puede venir vacío.

### Sin ninguna pista

- `serviceStatus = 256`.
- `vehicleStatus`: bits 4, 11, 32 y 34.
- `vehicleAlarm`: bits 1, 3, 22 y 26.
- `estimaciones`: `wait` y el bit 2 de `type`.

## Uso en este proyecto

`lib/navega.ts` es el único módulo que habla con esta API. Con
`FUENTE_DATOS=navega` (valor por defecto) alimenta los tres ciclos de ingesta:

| Ciclo | Endpoints | Notas |
|---|---|---|
| `posiciones` (cada 20 s) | `buses_servicios` (+ `parametros` y `lineas`, en caché 1 h) | Solo se publican buses con `vehicleLocationStatus` 5, 9, 12 o 14, sin `SIN_COMUNICACION`, en su propia línea y de líneas no ocultas. |
| `gtfs` (cada 24 h) | `parametros`, `lineas`, `paradas`, `rutasPrevistas`, `rutasActivas`, `rutas` | Solo las rutas planificadas (unión de previstas y activas). Cada ruta se guarda como un viaje sintético `navega-<routeId>`. |
| `calibracion` (cada 10 min) | `estimaciones` | Minutos = `departureTime − tiempo`; se excluyen las `TEORICA`. |

El certificado intermedio que falta (ver "TLS") va incluido en
`lib/adapters/navega-ca.ts`; no hace falta `NODE_EXTRA_CA_CERTS`. Caduca el
2027-11-02.

## Fuentes de datos alternativas

Siguen soportadas con `FUENTE_DATOS=datos-abiertos`:

- GTFS estático: `https://gtfs.emtmalaga.es/GTFS/google_transit.zip`.
- Web móvil, ya usada en `lib/calibrationCycle.ts`:
  `https://www.emtmalaga.es/emt-mobile/informacionParada.html?codParada=<cod>`.
