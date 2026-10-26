import { describe, it, expect } from "vitest";

import {
  derivarDestinos,
  directionIdASentido,
  normalizarRoutes,
  normalizarStops,
  normalizarGtfs,
  parsearCsvConCabecera,
  type CuerposGtfs,
} from "@/lib/gtfs";
import type { ViajeGtfs } from "@/lib/types";

// ---------------------------------------------------------------------------
// normalizarStops — stops.csv GTFS estándar es la fuente de la tabla `stops`
// ---------------------------------------------------------------------------

/** Cabecera real de `stops.csv` del portal de Málaga. */
const CABECERA_STOPS =
  "stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,zone_id,stop_url,location_type,parent_station,stop_timezone";

/** Construye un cuerpo `stops.csv` a partir de filas ya formateadas. */
function stopsCsv(...filas: string[]): string {
  return [CABECERA_STOPS, ...filas].join("\n");
}

describe("normalizarStops", () => {
  it("usa stop_code (código público EMT) como codParada, con [stop_lon, stop_lat] numéricos", () => {
    const filas = parsearCsvConCabecera(
      stopsCsv(
        "22,103,Plaza de la Merced,Parada,36.7236441803712,-4.41630272221197,,url,,,Europe/Madrid",
      ),
    );
    const stops = normalizarStops(filas);
    expect(stops).toEqual([
      {
        codParada: "103",
        nombre: "Plaza de la Merced",
        lon: -4.41630272221197,
        lat: 36.7236441803712,
      },
    ]);
  });

  it("usa stop_id como respaldo si falta stop_code", () => {
    const stops = normalizarStops(
      parsearCsvConCabecera(stopsCsv("39,,Alameda,Parada,36.72,-4.42,,,,,")),
    );
    expect(stops[0].codParada).toBe("39");
    expect(typeof stops[0].codParada).toBe("string");
  });

  it("descarta filas sin stop_id, sin nombre o con coordenadas no numéricas", () => {
    const stops = normalizarStops(
      parsearCsvConCabecera(
        stopsCsv(
          ",103,Sin id,Parada,36.72,-4.42,,,,,", // sin stop_id
          "40,104,,Parada,36.72,-4.42,,,,,", //      sin nombre
          "41,105,Coord mala,Parada,abc,-4.42,,,,,", // lat no numérica
          "42,106,Valida,Parada,36.73,-4.43,,,,,", //  válida
        ),
      ),
    );
    expect(stops.map((s) => s.codParada)).toEqual(["106"]);
  });

  it("tolera CSV entrecomillado (cabecera y campos entre comillas dobles)", () => {
    const csv = [
      '"stop_id","stop_code","stop_name","stop_desc","stop_lat","stop_lon"',
      '"22","103","Plaza de la Merced","Parada","36.7236","-4.4163"',
    ].join("\n");
    const stops = normalizarStops(parsearCsvConCabecera(csv));
    expect(stops).toEqual([
      { codParada: "103", nombre: "Plaza de la Merced", lon: -4.4163, lat: 36.7236 },
    ]);
  });

  it("deduplica por codParada conservando la primera aparición", () => {
    const stops = normalizarStops(
      parsearCsvConCabecera(
        stopsCsv(
          "42,106,Primera,Parada,36.73,-4.43,,,,,",
          "42,106,Segunda,Parada,36.99,-4.99,,,,,",
        ),
      ),
    );
    expect(stops).toHaveLength(1);
    expect(stops[0].nombre).toBe("Primera");
  });
});

// ---------------------------------------------------------------------------
// normalizarRoutes — el nombre legible es el trayecto (route_long_name)
// ---------------------------------------------------------------------------

describe("normalizarRoutes", () => {
  it("prefiere route_long_name (nombre de display) como nombre de la línea", () => {
    // En el GTFS de la EMT route_short_name coincide con route_id; el trayecto
    // legible está en route_long_name.
    const routes = normalizarRoutes(
      parsearCsvConCabecera(
        [
          "route_id,route_short_name,route_long_name",
          "1,1,Parque del Sur - Alameda Principal - San Andrés",
        ].join("\n"),
      ),
    );
    expect(routes).toEqual([
      { codLinea: 1, nombre: "Parque del Sur - Alameda Principal - San Andrés" },
    ]);
  });

  it("cae a route_short_name cuando falta route_long_name", () => {
    const routes = normalizarRoutes(
      parsearCsvConCabecera(
        ["route_id,route_short_name,route_long_name", "C1,C1,"].join("\n"),
      ),
    );
    // route_id "C1" no es entero, así que se descarta; se verifica el respaldo
    // con un route_id entero sin long_name.
    expect(routes).toEqual([]);

    const routes2 = normalizarRoutes(
      parsearCsvConCabecera(
        ["route_id,route_short_name,route_long_name", "91,91,"].join("\n"),
      ),
    );
    expect(routes2).toEqual([{ codLinea: 91, nombre: "91" }]);
  });

  it("descarta filas sin route_id entero", () => {
    const routes = normalizarRoutes(
      parsearCsvConCabecera(
        ["route_id,route_short_name,route_long_name", ",X,Sin id"].join("\n"),
      ),
    );
    expect(routes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// directionIdASentido — GTFS 0/1 → EMT 1/2
// ---------------------------------------------------------------------------

describe("directionIdASentido", () => {
  it("traduce 0→1 y 1→2", () => {
    expect(directionIdASentido("0")).toBe(1);
    expect(directionIdASentido("1")).toBe(2);
  });

  it("devuelve null para valores ausentes o fuera de 0/1", () => {
    expect(directionIdASentido("")).toBeNull();
    expect(directionIdASentido("2")).toBeNull();
    expect(directionIdASentido(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizarGtfs — integridad referencial y convenciones de la EMT
// ---------------------------------------------------------------------------

/**
 * Construye `CuerposGtfs` mínimos y coherentes. `stop_times.csv` referencia
 * `stop_id`, como en el feed real; `stops.csv` aporta el `stop_code`.
 */
function cuerposMinimos(overrides: Partial<CuerposGtfs> = {}): CuerposGtfs {
  return {
    routes: ["route_id,route_short_name,route_long_name", "7,7,Centro - Playa"].join(
      "\n",
    ),
    stops: stopsCsv(
      "22,103,Plaza de la Merced,Parada,36.7236,-4.4163,,,,,",
      "23,104,Compás de la Victoria,Parada,36.7274,-4.4135,,,,,",
    ),
    trips: [
      "trip_id,route_id,service_id,direction_id,shape_id",
      "T1,7,S1,0,SH1",
      "T2,7,S1,1,SH2",
    ].join("\n"),
    stopTimes: [
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
      "T1,06:20:00,06:20:00,22,1",
      "T1,06:21:00,06:21:00,23,2",
      "T1,06:22:00,06:22:00,999,3", // stop_id inexistente en stops.csv
    ].join("\n"),
    shapes: [
      "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence",
      "SH1,36.72,-4.41,1",
      "SH1,36.73,-4.42,2",
      "SH2,36.73,-4.42,1",
      "SH2,36.72,-4.41,2",
    ].join("\n"),
    calendarDates: "service_id,date,exception_type",
    ...overrides,
  };
}

describe("normalizarGtfs", () => {
  it("traduce stop_times.stop_id al codParada público y descarta huérfanos", () => {
    const dataset = normalizarGtfs(cuerposMinimos());

    expect(dataset.stopTimes.map((st) => st.codParada)).toEqual(["103", "104"]);
    const idsStops = new Set(dataset.stops.map((s) => s.codParada));
    for (const st of dataset.stopTimes) {
      expect(idsStops.has(st.codParada)).toBe(true);
    }
  });

  it("stops proviene de stops.csv con el código público", () => {
    const dataset = normalizarGtfs(cuerposMinimos());
    expect(dataset.stops.map((s) => s.codParada).sort()).toEqual(["103", "104"]);
    expect(dataset.stops.find((s) => s.codParada === "103")?.nombre).toBe(
      "Plaza de la Merced",
    );
  });

  it("expresa el sentido de trips y shapes en la convención EMT (1/2)", () => {
    const dataset = normalizarGtfs(cuerposMinimos());
    expect(dataset.trips.map((t) => t.sentido)).toEqual([1, 2]);
    expect(dataset.shapes.map((s) => s.sentido).sort()).toEqual([1, 2]);
  });

  it("captura trip_headsign en los trips y deriva el Destino por (codLinea, sentido)", () => {
    const dataset = normalizarGtfs(
      cuerposMinimos({
        trips: [
          "trip_id,route_id,service_id,direction_id,shape_id,trip_headsign",
          "T1,7,S1,0,SH1,San Andrés",
          "T2,7,S1,1,SH2,Centro",
        ].join("\n"),
      }),
    );
    expect(dataset.trips.map((t) => t.destino)).toEqual(["San Andrés", "Centro"]);
    expect(dataset.destinos).toEqual([
      { codLinea: 7, sentido: 1, destino: "San Andrés" },
      { codLinea: 7, sentido: 2, destino: "Centro" },
    ]);
  });

  it("omite el destino del trip cuando falta trip_headsign", () => {
    const dataset = normalizarGtfs(cuerposMinimos());
    for (const trip of dataset.trips) {
      expect(trip.destino).toBeUndefined();
    }
    expect(dataset.destinos).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// derivarDestinos — derivación determinista del Destino representativo
// ---------------------------------------------------------------------------

describe("derivarDestinos", () => {
  it("elige el headsign más frecuente por (codLinea, sentido)", () => {
    const trips: ViajeGtfs[] = [
      { tripId: "A", codLinea: 7, sentido: 1, destino: "San Andrés" },
      { tripId: "B", codLinea: 7, sentido: 1, destino: "San Andrés" },
      { tripId: "C", codLinea: 7, sentido: 1, destino: "Alameda" },
    ];
    expect(derivarDestinos(trips)).toEqual([
      { codLinea: 7, sentido: 1, destino: "San Andrés" },
    ]);
  });

  it("resuelve empates por orden lexicográfico, de forma determinista", () => {
    // "Alameda" y "Centro" empatan a 1; se elige el menor lexicográficamente.
    const trips: ViajeGtfs[] = [
      { tripId: "A", codLinea: 3, sentido: 2, destino: "Centro" },
      { tripId: "B", codLinea: 3, sentido: 2, destino: "Alameda" },
    ];
    expect(derivarDestinos(trips)).toEqual([
      { codLinea: 3, sentido: 2, destino: "Alameda" },
    ]);
    // El orden de llegada no altera el resultado (determinismo).
    expect(derivarDestinos([...trips].reverse())).toEqual([
      { codLinea: 3, sentido: 2, destino: "Alameda" },
    ]);
  });

  it("agrupa por (codLinea, sentido) y ordena la salida de forma estable", () => {
    const trips: ViajeGtfs[] = [
      { tripId: "A", codLinea: 7, sentido: 2, destino: "Centro" },
      { tripId: "B", codLinea: 7, sentido: 1, destino: "San Andrés" },
      { tripId: "C", codLinea: 3, sentido: 1, destino: "Teatinos" },
    ];
    expect(derivarDestinos(trips)).toEqual([
      { codLinea: 3, sentido: 1, destino: "Teatinos" },
      { codLinea: 7, sentido: 1, destino: "San Andrés" },
      { codLinea: 7, sentido: 2, destino: "Centro" },
    ]);
  });

  it("descarta trips sin sentido o sin destino", () => {
    const trips: ViajeGtfs[] = [
      { tripId: "A", codLinea: 7, destino: "Sin sentido" },
      { tripId: "B", codLinea: 7, sentido: 1 },
      { tripId: "C", codLinea: 7, sentido: 1, destino: "Válido" },
    ];
    expect(derivarDestinos(trips)).toEqual([
      { codLinea: 7, sentido: 1, destino: "Válido" },
    ]);
  });
});
