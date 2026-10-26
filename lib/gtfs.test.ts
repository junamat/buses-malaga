import { describe, it, expect } from "vitest";

import {
  directionIdASentido,
  normalizarStops,
  normalizarGtfs,
  parsearCsvConCabecera,
  type CuerposGtfs,
} from "@/lib/gtfs";

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
});
