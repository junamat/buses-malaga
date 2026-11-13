/**
 * Tests del adaptador de la API Navega (`lib/navega.ts`). Sin red: las
 * respuestas son recortes de capturas reales del 2026-11-13.
 */

import { describe, it, expect, vi } from "vitest";

import {
  CacheContextoPosiciones,
  construirContextoPosiciones,
  crearLectorPosicionesNavega,
  decodificarPolyline,
  direccionASentido,
  ejecutarCalibracionNavega,
  ejecutarRecargaTopologia,
  ensamblarTopologia,
  indexarLineas,
  indexarParadas,
  jornadaServicio,
  normalizarBuses,
  normalizarEstimaciones,
  normalizarRutas,
  parsearInstante,
  rutasPlanificadas,
  urlNavega,
  type ContextoBuses,
} from "@/lib/navega";
import { ingerirPosiciones, type IngestDeps } from "@/lib/ingest";
import type { HttpTransport, NuevoMinutoOficial, Repository } from "@/lib/ports";
import type { GtfsDataset, PosicionCaptura } from "@/lib/types";

// ---------------------------------------------------------------------------
// Capturas recortadas
// ---------------------------------------------------------------------------

const BASE = "https://navega.test/api";

const PARAMETROS = {
  topologiaDisponible: "2026.11.13.01",
  lineasOcultas: [0, 49, 88],
  sentidoCirculares: { "71": 1 },
};

/** Línea 1 (ida/vuelta), 71 circular, 49 oculta y una ruta de feria sin planificar. */
const LINEAS = {
  lineas: [
    {
      lineId: 1,
      lineLabel: "1",
      name: "Parque del Sur - Alameda Principal - San Andrés",
      configs: [
        {
          config: 3,
          sublines: [
            {
              sublineId: 303,
              routes: [
                { routeId: 12, destination: "Parque del Sur", direction: 2 },
                { routeId: 14, destination: "San Andrés", direction: 1 },
              ],
            },
          ],
        },
        {
          config: 1,
          sublines: [
            { sublineId: 1, routes: [{ routeId: 11, destination: "San Andrés", direction: 1 }] },
          ],
        },
      ],
    },
    {
      lineId: 71,
      lineLabel: "C1",
      name: "Circular 1",
      configs: [
        {
          config: 1,
          sublines: [
            { sublineId: 710, routes: [{ routeId: 711, destination: " Alameda ", direction: 3 }] },
          ],
        },
      ],
    },
    {
      lineId: 49,
      lineLabel: "49",
      name: "Personal",
      configs: [
        {
          config: 1,
          sublines: [{ sublineId: 490, routes: [{ routeId: 497, destination: "EMT", direction: 1 }] }],
        },
      ],
    },
  ],
  topologia: null,
};

const PARADAS = {
  paradas: [
    { nodeId: 1511, codPar: 172, name: "Hermanos Lumière", lat: 36.692966, lon: -4.463742 },
    { nodeId: 1512, codPar: 1261, name: "Parque del Sur", lat: 36.6921, lon: -4.4651 },
    { nodeId: 1513, codPar: 152, name: "San Andrés", lat: 36.7001, lon: -4.4401 },
    // Malformada: coordenadas no numéricas.
    { nodeId: 1514, codPar: 999, name: "Rota", lat: "36,7", lon: null },
  ],
};

/** Prefijo real del `polyline` de la ruta 12: tres puntos, longitud primero. */
const POLYLINE_RUTA_12 = "rcmoGszp~dATPljAju@";
const PUNTOS_RUTA_12 = [
  [-4.46369, 36.692922],
  [-4.463701, 36.692913],
  [-4.464908, 36.692043],
];

const RUTAS = [
  {
    lineId: 1,
    routeId: 12,
    direction: 2,
    nodes: [
      { position: 0, type: 1, nodeCode: 172, attributes: 1 },
      { position: 1035, type: 1, nodeCode: 1261, attributes: 0 },
      // Nodo que no es parada y parada desconocida: no entran en el recorrido.
      { position: 1100, type: 2, nodeCode: 5 },
      { position: 1200, type: 1, nodeCode: 4242 },
    ],
    polyline: POLYLINE_RUTA_12,
  },
  {
    lineId: 1,
    routeId: 14,
    direction: 1,
    nodes: [
      { position: 0, type: 1, nodeCode: 1261 },
      { position: 900, type: 1, nodeCode: 152 },
    ],
    polyline: POLYLINE_RUTA_12,
  },
  {
    lineId: 71,
    routeId: 711,
    direction: 3,
    nodes: [{ position: 0, type: 1, nodeCode: 152 }],
    polyline: POLYLINE_RUTA_12,
  },
  // Línea oculta: se descarta entera.
  { lineId: 49, routeId: 497, direction: 1, nodes: [{ type: 1, nodeCode: 172 }], polyline: POLYLINE_RUTA_12 },
];

const PREVISTAS = {
  jornadaInicio: "06-11-2026",
  jornadaFin: "27-11-2026",
  lineas: {
    "1": { linea: 1, sublineas: { "303": { sublinea: 303, rutas: { "12": { ruta: 12 }, "14": { ruta: 14 } } } } },
    "49": { linea: 49, sublineas: { "490": { sublinea: 490, rutas: { "497": { ruta: 497 } } } } },
  },
};

const ACTIVAS = {
  jornada: "13-11-2026",
  lineas: {
    "71": { linea: 71, sublineas: { "710": { sublinea: 710, rutas: { "711": { ruta: 711 } } } } },
  },
};

/** Bus en servicio, tal como lo publica `buses_servicios`. */
const BUS_BASE = {
  lineId: 1,
  carId: 1,
  currentLineId: 1,
  sublineId: 303,
  routeId: 14,
  currentRouteId: 12,
  serviceId: { date: "2026-11-13", service: "001-01", day: "V" },
  serviceStatus: 0,
  vehicleId: 676,
  plate: "4297JWC",
  vehicleStatus: 0,
  vehicleAlarm: 83886081,
  vehicleLocationStatus: 5,
  vehiclePosition: { lat: 36.729754, lng: -4.420353 },
  lastNode: { type: 1, num: 156 },
  nextNode: { type: 1, num: 157 },
};

const CONTEXTO: ContextoBuses = {
  sentidoPorRuta: new Map([
    [12, 2],
    [14, 1],
    [711, 1],
  ]),
  lineasOcultas: new Set([0, 49, 88]),
};

const CAPTURA = "2026-11-13T09:25:23.000Z";

// ---------------------------------------------------------------------------
// Dobles
// ---------------------------------------------------------------------------

/** Transporte que responde por endpoint (el último segmento de la ruta). */
function transporte(
  respuestas: Record<string, unknown>,
): { transport: HttpTransport; urls: string[] } {
  const urls: string[] = [];
  const transport: HttpTransport = {
    async get(url) {
      urls.push(url);
      const endpoint = new URL(url).pathname.split("/").pop() ?? "";
      if (!(endpoint in respuestas)) {
        throw new Error(`HTTP 404 en ${endpoint}`);
      }
      const respuesta = respuestas[endpoint];
      if (respuesta instanceof Error) {
        throw respuesta;
      }
      return typeof respuesta === "string" ? respuesta : JSON.stringify(respuesta);
    },
  };
  return { transport, urls };
}

function repositorio(overrides: Partial<Repository> = {}): {
  repository: Repository;
  datasets: GtfsDataset[];
  posiciones: PosicionCaptura[][];
  minutos: NuevoMinutoOficial[][];
} {
  const datasets: GtfsDataset[] = [];
  const posiciones: PosicionCaptura[][] = [];
  const minutos: NuevoMinutoOficial[][] = [];
  const repository = {
    async recargarGtfs(d: GtfsDataset) {
      datasets.push(d);
    },
    async insertPosiciones(p: PosicionCaptura[]) {
      posiciones.push(p);
    },
    async insertMinutosOficiales(m: NuevoMinutoOficial[]) {
      minutos.push(m);
    },
    async listParadas() {
      return {
        items: [
          { codParada: "1", nombre: "Feria", lon: 0, lat: 0 },
          { codParada: "2552", nombre: "Rastro", lon: 0, lat: 0 },
          { codParada: "no-numerica", nombre: "X", lon: 0, lat: 0 },
        ],
        next: null,
      };
    },
    ...overrides,
  } as unknown as Repository;
  return { repository, datasets, posiciones, minutos };
}

const TOPOLOGIA_OK = {
  parametros: PARAMETROS,
  lineas: LINEAS,
  paradas: PARADAS,
  rutasPrevistas: PREVISTAS,
  rutasActivas: ACTIVAS,
  rutas: RUTAS,
};

const AHORA = new Date("2026-11-13T09:25:23.000Z");

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

describe("jornadaServicio", () => {
  it("usa el día natural de Málaga a partir de las 04:30", () => {
    // 10:25 CET.
    expect(jornadaServicio(new Date("2026-11-13T09:25:00Z"))).toBe("13-11-2026");
    // 04:30 CET: ya es la jornada nueva.
    expect(jornadaServicio(new Date("2026-11-13T03:30:00Z"))).toBe("13-11-2026");
  });

  it("antes de las 04:30 sigue vigente la jornada anterior", () => {
    // 04:29 CET del 13 → jornada del 12.
    expect(jornadaServicio(new Date("2026-11-13T03:29:00Z"))).toBe("12-11-2026");
    // 01:00 CEST (verano) del 1 de julio → jornada del 30 de junio.
    expect(jornadaServicio(new Date("2026-06-30T23:00:00Z"))).toBe("30-06-2026");
  });
});

describe("urlNavega", () => {
  it("deja las comas de las listas sin codificar", () => {
    expect(urlNavega(`${BASE}/`, "rutas", { routeId: "11,12" })).toBe(
      `${BASE}/rutas?routeId=11,12`,
    );
    expect(urlNavega(BASE, "lineas")).toBe(`${BASE}/lineas`);
  });
});

describe("parsearInstante", () => {
  it("acepta el desfase sin dos puntos de `estimaciones`", () => {
    expect(parsearInstante("2026-11-13T10:27:29+0100")).toBe(
      Date.parse("2026-11-13T09:27:29Z"),
    );
    expect(parsearInstante("2026-11-13T10:25:23+01:00")).toBe(
      Date.parse("2026-11-13T09:25:23Z"),
    );
  });

  it("devuelve null para valores ausentes o no interpretables", () => {
    expect(parsearInstante(null)).toBeNull();
    expect(parsearInstante("ayer")).toBeNull();
  });
});

describe("direccionASentido", () => {
  it("mapea ida/vuelta y publica las circulares como sentido 1", () => {
    expect(direccionASentido(1)).toBe(1);
    expect(direccionASentido(2)).toBe(2);
    expect(direccionASentido(3)).toBe(1);
  });

  it("devuelve null para valores desconocidos", () => {
    expect(direccionASentido(0)).toBeNull();
    expect(direccionASentido("1")).toBeNull();
    expect(direccionASentido(undefined)).toBeNull();
  });
});

describe("decodificarPolyline", () => {
  it("decodifica un recorrido real en orden [lon, lat] con 6 decimales", () => {
    expect(decodificarPolyline(POLYLINE_RUTA_12)).toEqual(PUNTOS_RUTA_12);
  });

  it("descarta el recorrido si la precisión no cuadra (puntos fuera de rango)", () => {
    // Con 5 decimales la latitud saldría ~367°: mejor ningún recorrido que uno
    // desplazado.
    expect(decodificarPolyline(POLYLINE_RUTA_12, 5)).toEqual([]);
  });

  it("tolera una cadena truncada a mitad de un punto", () => {
    expect(decodificarPolyline(POLYLINE_RUTA_12.slice(0, -1))).toEqual(
      PUNTOS_RUTA_12.slice(0, 2),
    );
    expect(decodificarPolyline("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Topología
// ---------------------------------------------------------------------------

describe("indexarLineas", () => {
  it("indexa las rutas de todas las configuraciones con su línea y sentido", () => {
    const { nombres, rutas } = indexarLineas(LINEAS);
    expect([...nombres.keys()]).toEqual([1, 71, 49]);
    expect(rutas.get(12)).toEqual({
      routeId: 12,
      codLinea: 1,
      sentido: 2,
      destino: "Parque del Sur",
    });
    expect(rutas.get(11)?.sentido).toBe(1);
    // Circular → sentido 1; el destino se recorta.
    expect(rutas.get(711)).toEqual({
      routeId: 711,
      codLinea: 71,
      sentido: 1,
      destino: "Alameda",
    });
  });

  it("lanza si la respuesta no trae el array `lineas`", () => {
    expect(() => indexarLineas({ error: "x" })).toThrow(/lineas/);
    expect(() => indexarLineas("<html>")).toThrow(/lineas/);
  });
});

describe("indexarParadas", () => {
  it("indexa por codPar y descarta las paradas malformadas", () => {
    const paradas = indexarParadas(PARADAS);
    expect(paradas.size).toBe(3);
    expect(paradas.get(172)).toEqual({
      codParada: "172",
      nombre: "Hermanos Lumière",
      lon: -4.463742,
      lat: 36.692966,
    });
    expect(paradas.has(999)).toBe(false);
  });

  it("lanza si la respuesta no trae el array `paradas`", () => {
    expect(() => indexarParadas({})).toThrow(/paradas/);
  });
});

describe("rutasPlanificadas", () => {
  it("extrae los routeId de la estructura indexada por id", () => {
    expect([...rutasPlanificadas(PREVISTAS)].sort((a, b) => a - b)).toEqual([
      12, 14, 497,
    ]);
  });

  it("devuelve vacío cuando la jornada no está disponible", () => {
    expect(rutasPlanificadas({ jornada: "13-11-2026", lineas: {} }).size).toBe(0);
    expect(rutasPlanificadas(null).size).toBe(0);
  });
});

describe("normalizarRutas", () => {
  it("toma solo los nodos de tipo parada y decodifica la geometría", () => {
    const [ruta] = normalizarRutas(RUTAS);
    expect(ruta.routeId).toBe(12);
    expect(ruta.codParadas).toEqual([172, 1261, 4242]);
    expect(ruta.puntos).toEqual(PUNTOS_RUTA_12);
  });

  it("lanza si la respuesta no es un array", () => {
    expect(() => normalizarRutas({ rutas: [] })).toThrow(/rutas/);
  });
});

describe("ensamblarTopologia", () => {
  const dataset = ensamblarTopologia({
    lineas: indexarLineas(LINEAS),
    paradas: indexarParadas(PARADAS),
    rutas: normalizarRutas(RUTAS),
    lineasOcultas: new Set([0, 49, 88]),
  });

  it("modela cada ruta como un viaje sintético con sus paradas en orden", () => {
    expect(dataset.trips).toEqual([
      { tripId: "navega-12", codLinea: 1, sentido: 2, destino: "Parque del Sur" },
      { tripId: "navega-14", codLinea: 1, sentido: 1, destino: "San Andrés" },
      { tripId: "navega-711", codLinea: 71, sentido: 1, destino: "Alameda" },
    ]);
    // La parada desconocida (4242) no rompe la secuencia ni viola la FK.
    expect(dataset.stopTimes.filter((s) => s.tripId === "navega-12")).toEqual([
      { tripId: "navega-12", codParada: "172", stopSequence: 1 },
      { tripId: "navega-12", codParada: "1261", stopSequence: 2 },
    ]);
  });

  it("excluye las líneas ocultas y solo publica líneas y paradas con servicio", () => {
    expect(dataset.routes).toEqual([
      { codLinea: 1, nombre: "Parque del Sur - Alameda Principal - San Andrés" },
      { codLinea: 71, nombre: "Circular 1" },
    ]);
    expect(dataset.stops.map((s) => s.codParada).sort()).toEqual([
      "1261",
      "152",
      "172",
    ]);
    // Integridad referencial: todo stop_time apunta a un viaje y una parada.
    const viajes = new Set(dataset.trips.map((t) => t.tripId));
    const paradas = new Set(dataset.stops.map((s) => s.codParada));
    for (const st of dataset.stopTimes) {
      expect(viajes.has(st.tripId)).toBe(true);
      expect(paradas.has(st.codParada)).toBe(true);
    }
  });

  it("genera un recorrido por ruta y el destino por (línea, sentido)", () => {
    expect(dataset.shapes.map((s) => [s.codLinea, s.sentido])).toEqual([
      [1, 2],
      [1, 1],
      [71, 1],
    ]);
    expect(dataset.shapes[0].puntos).toEqual(PUNTOS_RUTA_12);
    expect(dataset.destinos).toEqual([
      { codLinea: 1, sentido: 1, destino: "San Andrés" },
      { codLinea: 1, sentido: 2, destino: "Parque del Sur" },
      { codLinea: 71, sentido: 1, destino: "Alameda" },
    ]);
    expect(dataset.calendarDates).toEqual([]);
  });
});

describe("ejecutarRecargaTopologia", () => {
  it("pide solo las rutas planificadas de líneas publicadas y recarga", async () => {
    const { transport, urls } = transporte(TOPOLOGIA_OK);
    const { repository, datasets } = repositorio();

    const { resultado, recuento } = await ejecutarRecargaTopologia(
      { transport, repository, now: () => AHORA },
      { baseUrl: BASE },
    );

    expect(resultado).toEqual({
      job: "gtfs",
      estado: "ok",
      fuente: BASE,
      runAt: AHORA.toISOString(),
    });
    // Unión de previstas (12, 14) y activas (711); la 497 es de línea oculta.
    expect(urls).toContain(`${BASE}/rutas?routeId=12,14,711`);
    expect(urls).toContain(`${BASE}/rutasPrevistas?day=13-11-2026`);
    expect(urls).toContain(`${BASE}/rutasActivas?day=13-11-2026`);
    expect(recuento).toEqual({ routes: 2, trips: 3, stops: 3, stopTimes: 5, shapes: 3 });
    expect(datasets).toHaveLength(1);
  });

  it("conserva los datos previos y reporta la URL si un endpoint falla", async () => {
    const { transport } = transporte({
      ...TOPOLOGIA_OK,
      paradas: new Error("Timeout de 30000 ms"),
    });
    const { repository, datasets } = repositorio();

    const { resultado } = await ejecutarRecargaTopologia(
      { transport, repository, now: () => AHORA },
      { baseUrl: BASE },
    );

    expect(resultado.estado).toBe("fallo");
    expect(resultado.fuente).toBe(`${BASE}/paradas`);
    expect(resultado.error).toContain("Timeout");
    expect(datasets).toHaveLength(0);
  });

  it("trata una página de error HTML como fallo de fuente", async () => {
    const { transport } = transporte({ ...TOPOLOGIA_OK, lineas: "<html>500</html>" });
    const { repository, datasets } = repositorio();

    const { resultado } = await ejecutarRecargaTopologia(
      { transport, repository, now: () => AHORA },
      { baseUrl: BASE },
    );

    expect(resultado.estado).toBe("fallo");
    expect(resultado.fuente).toBe(`${BASE}/lineas`);
    expect(resultado.error).toContain("no JSON");
    expect(datasets).toHaveLength(0);
  });

  it("no vacía las tablas si la jornada no tiene rutas planificadas", async () => {
    const { transport, urls } = transporte({
      ...TOPOLOGIA_OK,
      rutasPrevistas: { lineas: {} },
      rutasActivas: { jornada: "13-11-2026", lineas: {} },
    });
    const { repository, datasets } = repositorio();

    const { resultado } = await ejecutarRecargaTopologia(
      { transport, repository, now: () => AHORA },
      { baseUrl: BASE },
    );

    expect(resultado.estado).toBe("fallo");
    expect(resultado.error).toContain("13-11-2026");
    expect(urls.some((u) => u.includes("/rutas?"))).toBe(false);
    expect(datasets).toHaveLength(0);
  });

  it("no recarga si la topología normalizada queda vacía", async () => {
    // `rutas` responde, pero sin geometría ni paradas utilizables.
    const { transport } = transporte({ ...TOPOLOGIA_OK, rutas: [] });
    const { repository, datasets } = repositorio();

    const { resultado } = await ejecutarRecargaTopologia(
      { transport, repository, now: () => AHORA },
      { baseUrl: BASE },
    );

    expect(resultado.estado).toBe("fallo");
    expect(resultado.error).toContain("vacía");
    expect(datasets).toHaveLength(0);
  });

  it("reporta como fallo un error de escritura del repositorio", async () => {
    const { transport } = transporte(TOPOLOGIA_OK);
    const { repository } = repositorio({
      async recargarGtfs() {
        throw new Error("deadlock");
      },
    });

    const { resultado } = await ejecutarRecargaTopologia(
      { transport, repository, now: () => AHORA },
      { baseUrl: BASE },
    );

    expect(resultado.estado).toBe("fallo");
    expect(resultado.error).toBe("deadlock");
  });
});

// ---------------------------------------------------------------------------
// Posiciones
// ---------------------------------------------------------------------------

describe("normalizarBuses", () => {
  it("convierte un bus en servicio a PosicionCaptura", () => {
    const { validas, descartadas } = normalizarBuses(
      { buses: [BUS_BASE] },
      CONTEXTO,
      CAPTURA,
    );
    expect(descartadas).toEqual([]);
    expect(validas).toEqual([
      {
        codBus: 676,
        codLinea: 1,
        // Manda la ruta actual (12, vuelta), no la planificada (14, ida).
        sentido: 2,
        lon: -4.420353,
        lat: 36.729754,
        codParIni: "156",
        // La API no trae marca por vehículo: se usa el instante de ingesta.
        last_update: CAPTURA,
        captured_at: CAPTURA,
      },
    ]);
  });

  it("recurre a routeId si no hay ruta actual y omite codParIni sin último nodo", () => {
    const bus: Record<string, unknown> = { ...BUS_BASE, lastNode: [] };
    delete bus.currentRouteId;
    const { validas } = normalizarBuses({ buses: [bus] }, CONTEXTO, CAPTURA);
    expect(validas[0].sentido).toBe(1);
    expect(validas[0]).not.toHaveProperty("codParIni");
  });

  it("descarta con su motivo los buses que no se publican", () => {
    const sinEstado: Record<string, unknown> = { ...BUS_BASE };
    delete sinEstado.vehicleLocationStatus;
    const casos: [Record<string, unknown>, string][] = [
      [{ ...BUS_BASE, vehicleId: 0 }, "codBus_invalido"],
      // Deslocalizado (7), en cocheras (11) o sin la clave de estado.
      [{ ...BUS_BASE, vehicleLocationStatus: 7 }, "fuera_de_servicio"],
      [{ ...BUS_BASE, vehicleLocationStatus: 11 }, "fuera_de_servicio"],
      [sinEstado, "fuera_de_servicio"],
      // Circulando por otra línea distinta de la suya.
      [{ ...BUS_BASE, currentLineId: 3 }, "fuera_de_servicio"],
      // SIN_COMUNICACION (bit 14), combinado con otros bits (incluido uno > 31).
      [{ ...BUS_BASE, vehicleStatus: 16384 + 128 + 2 ** 34 }, "sin_comunicacion"],
      [{ ...BUS_BASE, vehiclePosition: { lat: null, lng: null } }, "coordenadas_invalidas"],
      [{ ...BUS_BASE, lineId: 0, currentLineId: 0 }, "codLinea_invalido"],
      [{ ...BUS_BASE, lineId: 49, currentLineId: 49 }, "linea_oculta"],
      [{ ...BUS_BASE, routeId: 9999, currentRouteId: 9998 }, "sentido_invalido"],
    ];

    const { validas, descartadas } = normalizarBuses(
      { buses: casos.map(([bus]) => bus) },
      CONTEXTO,
      CAPTURA,
    );

    expect(validas).toEqual([]);
    expect(descartadas.map((d) => d.motivo)).toEqual(casos.map(([, m]) => m));
  });

  it("no confunde otros bits de vehicleStatus con SIN_COMUNICACION", () => {
    // AVERIADO (bit 29) + bit 23 + ULTIMA_VUELTA: buses en servicio normal.
    const bus = { ...BUS_BASE, vehicleStatus: 536870912 + 8388608 + 128 };
    expect(normalizarBuses({ buses: [bus] }, CONTEXTO, CAPTURA).validas).toHaveLength(1);
  });

  it("acepta los estados en servicio: desvío, espera en cabecera y manual", () => {
    const buses = [9, 12, 14].map((estado, i) => ({
      ...BUS_BASE,
      vehicleId: 700 + i,
      vehicleLocationStatus: estado,
    }));
    expect(normalizarBuses({ buses }, CONTEXTO, CAPTURA).validas).toHaveLength(3);
  });

  it("lanza si la respuesta no trae el array `buses`", () => {
    expect(() => normalizarBuses({ error: 400 }, CONTEXTO, CAPTURA)).toThrow(
      /buses_servicios/,
    );
  });
});

describe("construirContextoPosiciones", () => {
  it("lista las líneas publicadas y el sentido de cada ruta", () => {
    const contexto = construirContextoPosiciones(PARAMETROS, LINEAS);
    expect(contexto.lineIds).toEqual([1, 71]);
    expect(contexto.sentidoPorRuta.get(12)).toBe(2);
    expect(contexto.sentidoPorRuta.get(711)).toBe(1);
    expect(contexto.lineasOcultas.has(49)).toBe(true);
  });

  it("lanza si no queda ninguna línea publicada", () => {
    expect(() => construirContextoPosiciones(PARAMETROS, { lineas: [] })).toThrow();
  });
});

describe("crearLectorPosicionesNavega", () => {
  it("pide todas las líneas publicadas en una petición y reutiliza el contexto", async () => {
    const { transport, urls } = transporte({
      parametros: PARAMETROS,
      lineas: LINEAS,
      buses_servicios: { buses: [BUS_BASE] },
    });
    const lector = crearLectorPosicionesNavega({
      baseUrl: BASE,
      cache: new CacheContextoPosiciones(),
    });

    const primera = await lector(transport, CAPTURA, 1000);
    await lector(transport, CAPTURA, 1000);

    expect(primera.validas).toHaveLength(1);
    expect(urls).toEqual([
      `${BASE}/parametros`,
      `${BASE}/lineas`,
      `${BASE}/buses_servicios?lineId=1,71`,
      // Segundo ciclo: el contexto sale de la caché.
      `${BASE}/buses_servicios?lineId=1,71`,
    ]);
  });

  it("refresca el contexto al caducar y sigue con el anterior si el refresco falla", async () => {
    let reloj = 0;
    const cache = new CacheContextoPosiciones(1000, () => reloj);
    const respuestas: Record<string, unknown> = {
      parametros: PARAMETROS,
      lineas: LINEAS,
      buses_servicios: { buses: [BUS_BASE] },
    };
    const { transport, urls } = transporte(respuestas);
    const lector = crearLectorPosicionesNavega({ baseUrl: BASE, cache });

    await lector(transport, CAPTURA, 1000);
    reloj = 2000;
    respuestas.lineas = new Error("HTTP 500");
    const { validas } = await lector(transport, CAPTURA, 1000);

    // Reintentó `lineas`, falló y usó la copia anterior.
    expect(urls.filter((u) => u.endsWith("/lineas"))).toHaveLength(2);
    expect(validas).toHaveLength(1);
  });

  it("se integra con ingerirPosiciones: un cuerpo no JSON es fallo y se reintenta", async () => {
    const get = vi
      .fn<HttpTransport["get"]>()
      .mockImplementation(async (url) => {
        if (url.endsWith("/parametros")) return JSON.stringify(PARAMETROS);
        if (url.endsWith("/lineas")) return JSON.stringify(LINEAS);
        return "<html>429</html>";
      });
    const { repository, posiciones } = repositorio();
    const deps: IngestDeps = {
      transport: { get },
      repository,
      now: () => AHORA,
      sleep: async () => {},
    };

    const { resultado, insertadas } = await ingerirPosiciones(deps, {
      fuenteUrl: `${BASE}/buses_servicios`,
      lector: crearLectorPosicionesNavega({
        baseUrl: BASE,
        cache: new CacheContextoPosiciones(),
      }),
    });

    expect(resultado.estado).toBe("fallo");
    expect(resultado.fuente).toBe(`${BASE}/buses_servicios`);
    expect(resultado.error).toContain("no JSON");
    expect(insertadas).toBe(0);
    expect(posiciones).toHaveLength(0);
    // Dos intentos de `buses_servicios` (reintento acotado del ciclo).
    expect(get.mock.calls.filter(([u]) => u.includes("buses_servicios"))).toHaveLength(2);
  });

  it("se integra con ingerirPosiciones: inserta los buses válidos", async () => {
    const { transport } = transporte({
      parametros: PARAMETROS,
      lineas: LINEAS,
      buses_servicios: {
        buses: [BUS_BASE, { ...BUS_BASE, vehicleId: 677, vehicleLocationStatus: 7 }],
      },
    });
    const { repository, posiciones } = repositorio();

    const { resultado, insertadas, descartadas } = await ingerirPosiciones(
      { transport, repository, now: () => AHORA },
      {
        fuenteUrl: `${BASE}/buses_servicios`,
        lector: crearLectorPosicionesNavega({
          baseUrl: BASE,
          cache: new CacheContextoPosiciones(),
        }),
      },
    );

    expect(resultado.estado).toBe("ok");
    expect(insertadas).toBe(1);
    expect(descartadas.map((d) => d.motivo)).toEqual(["fuera_de_servicio"]);
    expect(posiciones[0][0].captured_at).toBe(AHORA.toISOString());
  });
});

// ---------------------------------------------------------------------------
// Calibración
// ---------------------------------------------------------------------------

const ESTIMACIONES = {
  codPar: [1, 2552],
  estimaciones: [
    // 2 min 7 s → 2 min.
    {
      type: 0,
      flags: 0,
      vehicleId: 689,
      line: { id: 19, label: 19 },
      codPar: 2552,
      arrivalTime: "2026-11-13T10:27:29+0100",
      departureTime: "2026-11-13T10:27:30+0100",
    },
    // Ya en la parada (salida pasada) → "Ahora" = 0.
    {
      type: 0,
      flags: 16777216,
      line: { id: 25 },
      codPar: 2552,
      departureTime: "2026-11-13T10:25:00+0100",
    },
    // Teórica (horario, no bus real) y teórica con bit 2: fuera.
    { type: 1, line: { id: 1 }, codPar: 1, departureTime: "2026-11-13T10:40:00+0100" },
    { type: 3, line: { id: 1 }, codPar: 1, departureTime: "2026-11-13T10:41:00+0100" },
    // Fuera de [0, 120] min.
    { type: 0, line: { id: 1 }, codPar: 1, departureTime: "2026-11-13T13:00:00+0100" },
    // Malformada: sin línea.
    { type: 0, codPar: 1, departureTime: "2026-11-13T10:30:00+0100" },
    // INCORPORACION (bit 4) sí cuenta; sin departureTime usa arrivalTime.
    { type: 4, line: { id: 3 }, codPar: 1, arrivalTime: "2026-11-13T10:35:23+0100" },
  ],
  exclusiones: [],
  tiempo: "2026-11-13T10:25:23+01:00",
};

describe("normalizarEstimaciones", () => {
  it("calcula los minutos como departureTime − tiempo, con su línea real", () => {
    expect(normalizarEstimaciones(ESTIMACIONES)).toEqual([
      { codParada: "2552", codLinea: 19, minutos: 2 },
      { codParada: "2552", codLinea: 25, minutos: 0 },
      { codParada: "1", codLinea: 3, minutos: 10 },
    ]);
  });

  it("lanza si falta `estimaciones` o el instante `tiempo`", () => {
    expect(() => normalizarEstimaciones({ tiempo: ESTIMACIONES.tiempo })).toThrow(
      /estimaciones/,
    );
    expect(() => normalizarEstimaciones({ estimaciones: [] })).toThrow(/tiempo/);
  });
});

describe("ejecutarCalibracionNavega", () => {
  it("muestrea las paradas en una sola petición y guarda los minutos", async () => {
    const { transport, urls } = transporte({ estimaciones: ESTIMACIONES });
    const { repository, minutos } = repositorio();

    const resultado = await ejecutarCalibracionNavega(
      { transport, repository, now: () => AHORA },
      { baseUrl: BASE },
    );

    expect(resultado).toEqual({
      job: "calibracion",
      estado: "ok",
      fuente: `${BASE}/estimaciones`,
      runAt: AHORA.toISOString(),
    });
    // Solo los códigos numéricos: `codPar` lo es en Navega.
    expect(urls).toEqual([`${BASE}/estimaciones?codPar=1,2552`]);
    expect(minutos).toHaveLength(1);
    expect(minutos[0]).toHaveLength(3);
  });

  it("omite el muestreo sin lanzar si la fuente falla", async () => {
    const { transport } = transporte({ estimaciones: new Error("HTTP 429") });
    const { repository, minutos } = repositorio();

    const resultado = await ejecutarCalibracionNavega(
      { transport, repository, now: () => AHORA },
      { baseUrl: BASE },
    );

    expect(resultado.estado).toBe("fallo");
    expect(resultado.error).toBe("HTTP 429");
    expect(minutos).toHaveLength(0);
  });

  it("no pide nada si no hay paradas que muestrear", async () => {
    const { transport, urls } = transporte({});
    const { repository } = repositorio();

    const resultado = await ejecutarCalibracionNavega(
      { transport, repository, now: () => AHORA },
      { baseUrl: BASE, obtenerCodParadas: async () => [] },
    );

    expect(resultado.estado).toBe("ok");
    expect(urls).toEqual([]);
  });
});
