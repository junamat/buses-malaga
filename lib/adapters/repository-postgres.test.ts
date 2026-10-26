/**
 * Tests del adaptador `Repository` sobre Postgres.
 *
 * Verifican la lógica verificable sin base de datos: los helpers puros de
 * paginación, el mapeo fila → modelo interno y la construcción de SQL
 * parametrizado, y el cableado de la clase `PostgresRepository` sobre un
 * `QueryClient` doble (que captura el SQL emitido y devuelve filas fijas). El
 * test de integración con una base de datos real es la tarea 1.4 (opcional).
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import type { QueryResultRow } from "pg";
import {
  normalizeLimit,
  parseOffsetCursor,
  buildPagina,
  mapLinea,
  mapParada,
  mapParadaCercana,
  mapBus,
  mapFavorito,
  mapAportacion,
  buildListLineasSql,
  buildListParadasSql,
  buildFindParadasCercanasSql,
  buildListBusesSql,
  VENTANA_SERVICIO_SEGUNDOS,
  buildInsertPosicionesSql,
  buildPurgePosicionesSql,
  buildListFavoritosSql,
  buildCreateFavoritoSql,
  buildDeleteFavoritoSql,
  buildListAportacionesVigentesSql,
  buildCreateAportacionSql,
  buildLogIngestaSql,
  PostgresRepository,
  type QueryClient,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  APORTACION_VIGENCIA_SEGUNDOS,
} from "@/lib/adapters/repository-postgres";
import type { PosicionCaptura } from "@/lib/types";

// ---------------------------------------------------------------------------
// Doble de QueryClient: captura las llamadas y devuelve filas programadas.
// ---------------------------------------------------------------------------

interface Call {
  text: string;
  params: unknown[];
}

function fakeClient(
  rows: QueryResultRow[] = [],
  rowCount: number | null = null,
): { client: QueryClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: QueryClient = {
    async query<R extends QueryResultRow>(text: string, params?: unknown[]) {
      calls.push({ text, params: params ?? [] });
      return {
        rows: rows as unknown as R[],
        rowCount: rowCount ?? rows.length,
      };
    },
  };
  return { client, calls };
}

// ---------------------------------------------------------------------------
// Paginación
// ---------------------------------------------------------------------------

describe("normalizeLimit", () => {
  it("aplica el valor por defecto ante ausencia o valores no positivos", () => {
    expect(normalizeLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
    expect(normalizeLimit(0)).toBe(DEFAULT_PAGE_LIMIT);
    expect(normalizeLimit(-5)).toBe(DEFAULT_PAGE_LIMIT);
    expect(normalizeLimit(Number.NaN)).toBe(DEFAULT_PAGE_LIMIT);
  });

  it("trunca a entero y respeta el tope máximo", () => {
    expect(normalizeLimit(10)).toBe(10);
    expect(normalizeLimit(10.9)).toBe(10);
    expect(normalizeLimit(1000)).toBe(MAX_PAGE_LIMIT);
  });

  it("propiedad: el resultado siempre está en [1, MAX_PAGE_LIMIT]", () => {
    fc.assert(
      fc.property(
        fc.option(fc.double({ noNaN: false }), { nil: undefined }),
        (limite) => {
          const r = normalizeLimit(limite as number | undefined);
          expect(r).toBeGreaterThanOrEqual(1);
          expect(r).toBeLessThanOrEqual(MAX_PAGE_LIMIT);
          expect(Number.isInteger(r)).toBe(true);
        },
      ),
    );
  });
});

describe("parseOffsetCursor", () => {
  it("trata ausencia/vacío/inválido como offset 0", () => {
    expect(parseOffsetCursor(undefined)).toBe(0);
    expect(parseOffsetCursor(null)).toBe(0);
    expect(parseOffsetCursor("")).toBe(0);
    expect(parseOffsetCursor("abc")).toBe(0);
    expect(parseOffsetCursor("-3")).toBe(0);
  });

  it("parsea offsets positivos", () => {
    expect(parseOffsetCursor("50")).toBe(50);
    expect(parseOffsetCursor("200")).toBe(200);
  });
});

describe("buildPagina", () => {
  it("emite cursor a la página siguiente cuando hay más filas que el límite", () => {
    const rows = [1, 2, 3];
    const pagina = buildPagina(rows, 2, 10);
    expect(pagina.items).toEqual([1, 2]);
    expect(pagina.next).toBe("12");
  });

  it("marca fin de paginación (next=null) cuando no hay excedente", () => {
    const pagina = buildPagina([1, 2], 2, 0);
    expect(pagina.items).toEqual([1, 2]);
    expect(pagina.next).toBeNull();
  });

  it("propiedad: next es null sii |rows| <= limite", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { maxLength: 50 }),
        fc.integer({ min: 1, max: 50 }),
        fc.nat(),
        (rows, limite, offset) => {
          const pagina = buildPagina(rows, limite, offset);
          if (rows.length > limite) {
            expect(pagina.items.length).toBe(limite);
            expect(pagina.next).toBe(String(offset + limite));
          } else {
            expect(pagina.items).toEqual(rows);
            expect(pagina.next).toBeNull();
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Mapeo de filas
// ---------------------------------------------------------------------------

describe("mapeadores de fila", () => {
  it("mapLinea convierte route_id a número y nombre null a undefined", () => {
    expect(mapLinea({ route_id: "41", nombre: null })).toEqual({
      codLinea: 41,
      nombre: undefined,
    });
    expect(mapLinea({ route_id: 7, nombre: "Línea 7" })).toEqual({
      codLinea: 7,
      nombre: "Línea 7",
    });
  });

  it("mapParada preserva cod_parada textual y coordenadas numéricas", () => {
    expect(
      mapParada({ cod_parada: "1234", nombre: "Alameda", lon: "-4.42", lat: "36.72" }),
    ).toEqual({ codParada: "1234", nombre: "Alameda", lon: -4.42, lat: 36.72 });
  });

  it("mapParadaCercana añade distanciaMetros numérica", () => {
    const p = mapParadaCercana({
      cod_parada: "1",
      nombre: "X",
      lon: -4,
      lat: 36,
      distancia_metros: "125.5",
    });
    expect(p.distanciaMetros).toBe(125.5);
    expect(p.lon).toBe(-4);
  });

  it("mapBus normaliza tipos y serializa timestamps a ISO", () => {
    const d = new Date("2024-01-01T10:00:00.000Z");
    const bus = mapBus({
      cod_bus: "900",
      cod_linea: "41",
      sentido: "1",
      lon: "-4.4",
      lat: "36.7",
      last_update: d,
      captured_at: "2024-01-01T10:00:05.000Z",
    });
    expect(bus.codBus).toBe(900);
    expect(bus.sentido).toBe(1);
    expect(bus.last_update).toBe("2024-01-01T10:00:00.000Z");
    expect(bus.captured_at).toBe("2024-01-01T10:00:05.000Z");
  });

  it("mapFavorito traduce columnas nullables a campos opcionales", () => {
    expect(
      mapFavorito({
        id: "uuid-1",
        user_id: "user-1",
        tipo: "parada",
        cod_parada: "99",
        cod_linea: null,
      }),
    ).toEqual({
      id: "uuid-1",
      userId: "user-1",
      tipo: "parada",
      codParada: "99",
      codLinea: undefined,
    });
  });

  it("mapAportacion convierte cod_bus a número y created_at a ISO", () => {
    const a = mapAportacion({
      id: "a1",
      user_id: "u1",
      cod_bus: "900",
      opcion: "lleno",
      created_at: new Date("2024-01-01T00:00:00.000Z"),
    });
    expect(a.codBus).toBe(900);
    expect(a.created_at).toBe("2024-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Construcción de SQL
// ---------------------------------------------------------------------------

describe("construcción de SQL", () => {
  it("buildListLineasSql pide limite+1 filas con offset", () => {
    const { text, params } = buildListLineasSql(50, 100);
    expect(text).toContain("FROM routes");
    expect(text).toContain("ORDER BY route_id ASC");
    expect(params).toEqual([51, 100]);
  });

  it("buildListParadasSql sin filtro recorre todas las paradas", () => {
    const { text, params } = buildListParadasSql(undefined, 50, 0);
    expect(text).toContain("FROM stops");
    expect(text).not.toContain("JOIN");
    expect(params).toEqual([51, 0]);
  });

  it("buildListParadasSql con codLinea une por trips/stop_times", () => {
    const { text, params } = buildListParadasSql({ codLinea: 41 }, 20, 40);
    expect(text).toContain("JOIN stop_times");
    expect(text).toContain("JOIN trips");
    expect(text).toContain("t.route_id = $1");
    expect(params).toEqual([41, 21, 40]);
  });

  it("buildFindParadasCercanasSql ordena por distancia y usa [lon, lat] en ST_MakePoint", () => {
    const { text, params } = buildFindParadasCercanasSql(-4.42, 36.72, 500, 10);
    expect(text).toContain("ST_DWithin");
    expect(text).toContain("ST_MakePoint($1, $2)");
    expect(text).toContain("ORDER BY distancia_metros ASC");
    // params: lon primero, lat después (orden canónico), radio, límite.
    expect(params).toEqual([-4.42, 36.72, 500, 10]);
  });

  it("buildListBusesSql sin filtro selecciona la última captura por bus en servicio", () => {
    const { text, params } = buildListBusesSql(undefined, 50, 0);
    expect(text).toContain("DISTINCT ON (bp.cod_bus)");
    expect(text).toContain("last_update DESC, bp.captured_at DESC");
    // Solo buses de la última tanda de ingesta (no toda la ventana de 6 h).
    expect(text).toContain(
      "(SELECT max(captured_at) FROM bus_positions) - make_interval(secs => $1)",
    );
    expect(text).not.toContain(") latest WHERE");
    expect(params).toEqual([VENTANA_SERVICIO_SEGUNDOS, 51, 0]);
  });

  it("buildListBusesSql compone filtros de línea y sentido con AND", () => {
    const { text, params } = buildListBusesSql(
      { codLineas: [1, 2], sentido: 1 },
      50,
      0,
    );
    expect(text).toContain("cod_linea = ANY($2::bigint[])");
    expect(text).toContain("sentido = $3");
    expect(text).toContain(" AND ");
    expect(params).toEqual([VENTANA_SERVICIO_SEGUNDOS, [1, 2], 1, 51, 0]);
  });

  it("buildListBusesSql filtra después de elegir la última captura por bus", () => {
    const { text } = buildListBusesSql({ sentido: 2 }, 50, 0);
    // El filtro va sobre el resultado de DISTINCT ON, no dentro de él: un bus
    // que cambió de sentido no debe reaparecer con una captura antigua.
    const idxDistinct = text.indexOf("DISTINCT ON");
    const idxFiltro = text.indexOf("sentido = $2");
    expect(text).toContain(") latest WHERE sentido = $2");
    expect(idxFiltro).toBeGreaterThan(idxDistinct);
  });

  it("buildListBusesSql ignora un conjunto de líneas vacío", () => {
    const { text, params } = buildListBusesSql({ codLineas: [] }, 50, 0);
    expect(text).not.toContain(") latest WHERE");
    expect(params).toEqual([VENTANA_SERVICIO_SEGUNDOS, 51, 0]);
  });

  it("buildInsertPosicionesSql devuelve null sin capturas", () => {
    expect(buildInsertPosicionesSql([])).toBeNull();
  });

  it("buildInsertPosicionesSql desenrolla columnas con unnest en [lon, lat]", () => {
    const capturas: PosicionCaptura[] = [
      {
        codBus: 1,
        codLinea: 41,
        sentido: 1,
        lon: -4.4,
        lat: 36.7,
        codParIni: "100",
        last_update: "2024-01-01T00:00:00Z",
        captured_at: "2024-01-01T00:00:01Z",
      },
      {
        codBus: 2,
        codLinea: 42,
        sentido: 2,
        lon: -4.5,
        lat: 36.8,
        last_update: "2024-01-01T00:00:02Z",
        captured_at: "2024-01-01T00:00:03Z",
      },
    ];
    const stmt = buildInsertPosicionesSql(capturas)!;
    expect(stmt.text).toContain("INSERT INTO bus_positions");
    expect(stmt.text).toContain("unnest(");
    // 8 columnas en el orden del esquema.
    expect(stmt.params).toEqual([
      [1, 2],
      [41, 42],
      [1, 2],
      [-4.4, -4.5],
      [36.7, 36.8],
      ["100", null],
      ["2024-01-01T00:00:00Z", "2024-01-01T00:00:02Z"],
      ["2024-01-01T00:00:01Z", "2024-01-01T00:00:03Z"],
    ]);
  });

  it("buildPurgePosicionesSql borra por ventana de retención en segundos", () => {
    const { text, params } = buildPurgePosicionesSql(21600);
    expect(text).toContain("DELETE FROM bus_positions");
    expect(text).toContain("make_interval(secs => $1)");
    expect(params).toEqual([21600]);
  });

  it("buildListFavoritosSql filtra por user_id", () => {
    const { text, params } = buildListFavoritosSql("user-1");
    expect(text).toContain("FROM favorites");
    expect(text).toContain("user_id = $1");
    expect(params).toEqual(["user-1"]);
  });

  it("buildCreateFavoritoSql devuelve la fila y mapea campos opcionales a null", () => {
    const { text, params } = buildCreateFavoritoSql({
      userId: "u1",
      tipo: "linea",
      codLinea: 41,
    });
    expect(text).toContain("INSERT INTO favorites");
    expect(text).toContain("RETURNING");
    expect(params).toEqual(["u1", "linea", null, 41]);
  });

  it("buildDeleteFavoritoSql restringe por dueño e id", () => {
    const { text, params } = buildDeleteFavoritoSql("u1", "fav-1");
    expect(text).toContain("DELETE FROM favorites");
    expect(text).toContain("user_id = $1 AND id = $2");
    expect(params).toEqual(["u1", "fav-1"]);
  });

  it("buildListAportacionesVigentesSql aplica la ventana de vigencia de 60 min", () => {
    const { text, params } = buildListAportacionesVigentesSql(900);
    expect(text).toContain("FROM vehicle_contributions");
    expect(text).toContain("make_interval(secs => $2)");
    expect(params).toEqual([900, APORTACION_VIGENCIA_SEGUNDOS]);
    expect(APORTACION_VIGENCIA_SEGUNDOS).toBe(3600);
  });

  it("buildCreateAportacionSql inserta y devuelve la fila", () => {
    const { text, params } = buildCreateAportacionSql({
      userId: "u1",
      codBus: 900,
      opcion: "lleno",
    });
    expect(text).toContain("INSERT INTO vehicle_contributions");
    expect(text).toContain("RETURNING");
    expect(params).toEqual(["u1", 900, "lleno"]);
  });

  it("buildLogIngestaSql registra fuente, estado y run_at", () => {
    const { text, params } = buildLogIngestaSql({
      job: "posiciones",
      estado: "ok",
      fuente: "https://datos/lineasyubicaciones.csv",
      runAt: "2024-01-01T00:00:00.000Z",
    });
    expect(text).toContain("INSERT INTO ingest_log");
    expect(text).toContain("(fuente, estado, run_at)");
    expect(params).toEqual([
      "https://datos/lineasyubicaciones.csv",
      "ok",
      "2024-01-01T00:00:00.000Z",
    ]);
  });

  it("buildLogIngestaSql usa el nombre del job como fuente cuando falta", () => {
    const { params } = buildLogIngestaSql({
      job: "purga",
      estado: "ok",
      runAt: "2024-01-01T00:00:00.000Z",
    });
    // La columna `fuente` es NOT NULL; sin fuente externa se registra el job.
    expect(params).toEqual(["purga", "ok", "2024-01-01T00:00:00.000Z"]);
  });
});

// ---------------------------------------------------------------------------
// PostgresRepository: cableado sobre un QueryClient doble
// ---------------------------------------------------------------------------

describe("PostgresRepository", () => {
  it("listLineas mapea filas y pagina", async () => {
    const { client, calls } = fakeClient([
      { route_id: 1, nombre: "A" },
      { route_id: 2, nombre: null },
    ]);
    const repo = new PostgresRepository(client);
    const pagina = await repo.listLineas({ limite: 10 });
    expect(pagina.items).toEqual([
      { codLinea: 1, nombre: "A" },
      { codLinea: 2, nombre: undefined },
    ]);
    expect(pagina.next).toBeNull();
    expect(calls[0].params).toEqual([11, 0]);
  });

  it("listBuses propaga el filtro al SQL", async () => {
    const { client, calls } = fakeClient([]);
    const repo = new PostgresRepository(client);
    await repo.listBuses({ codLineas: [41], sentido: 2 }, { cursor: "50" });
    expect(calls[0].text).toContain("sentido = $3");
    expect(calls[0].params).toEqual([
      VENTANA_SERVICIO_SEGUNDOS,
      [41],
      2,
      DEFAULT_PAGE_LIMIT + 1,
      50,
    ]);
  });

  it("insertPosiciones no consulta cuando no hay capturas", async () => {
    const { client, calls } = fakeClient();
    const repo = new PostgresRepository(client);
    await repo.insertPosiciones([]);
    expect(calls).toHaveLength(0);
  });

  it("purgePosicionesAntiguas devuelve el número de filas borradas", async () => {
    const { client } = fakeClient([], 7);
    const repo = new PostgresRepository(client);
    expect(await repo.purgePosicionesAntiguas(21600)).toBe(7);
  });

  it("createFavorito devuelve la fila insertada mapeada", async () => {
    const { client } = fakeClient([
      {
        id: "fav-1",
        user_id: "u1",
        tipo: "parada_linea",
        cod_parada: "99",
        cod_linea: 41,
      },
    ]);
    const repo = new PostgresRepository(client);
    const fav = await repo.createFavorito({
      userId: "u1",
      tipo: "parada_linea",
      codParada: "99",
      codLinea: 41,
    });
    expect(fav).toEqual({
      id: "fav-1",
      userId: "u1",
      tipo: "parada_linea",
      codParada: "99",
      codLinea: 41,
    });
  });

  it("logIngesta emite el INSERT en ingest_log con el resultado del ciclo", async () => {
    const { client, calls } = fakeClient();
    const repo = new PostgresRepository(client);
    await repo.logIngesta({
      job: "posiciones",
      estado: "fallo",
      fuente: "https://datos/lineasyubicaciones.csv",
      error: "timeout",
      runAt: "2024-01-01T00:00:00.000Z",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("INSERT INTO ingest_log");
    expect(calls[0].params).toEqual([
      "https://datos/lineasyubicaciones.csv",
      "fallo",
      "2024-01-01T00:00:00.000Z",
    ]);
  });

  it("listAportacionesVigentes mapea el conjunto devuelto", async () => {
    const { client } = fakeClient([
      {
        id: "a1",
        user_id: "u1",
        cod_bus: 900,
        opcion: "lleno",
        created_at: "2024-01-01T00:00:00.000Z",
      },
    ]);
    const repo = new PostgresRepository(client);
    const aportaciones = await repo.listAportacionesVigentes(900);
    expect(aportaciones).toHaveLength(1);
    expect(aportaciones[0].codBus).toBe(900);
  });
});
