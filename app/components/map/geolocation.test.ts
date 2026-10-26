/**
 * Tests de la lógica de geolocalización de paradas cercanas (tarea 10.6,
 * `app/components/map/geolocation.ts`).
 *
 * - Timeout de geolocalización a 10 s → estado de error "timeout" (Requisito 6.5).
 * - Denegación de permiso → estado de error "denegado" (Requisito 6.4).
 * - Concesión + paradas → estado "resultado"; sin paradas → "vacio" (6.3, 6.6).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  estadoDesdeError,
  obtenerUbicacion,
  buscarParadasCercanas,
  PERMISSION_DENIED,
  TIMEOUT,
  type GeolocalizadorMinimo,
} from "@/app/components/map/geolocation";
import * as busLayerData from "@/app/components/map/busLayerData";

function geolocalizadorExito(lat: number, lon: number): GeolocalizadorMinimo {
  return {
    getCurrentPosition: (onSuccess) =>
      onSuccess({ coords: { latitude: lat, longitude: lon } }),
  };
}

function geolocalizadorError(code: number, message = "err"): GeolocalizadorMinimo {
  return {
    getCurrentPosition: (_onSuccess, onError) => onError({ code, message }),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("estadoDesdeError", () => {
  it("mapea permiso denegado (6.4)", () => {
    const estado = estadoDesdeError({ code: PERMISSION_DENIED, message: "" });
    expect(estado.causa).toBe("denegado");
  });

  it("mapea timeout (6.5)", () => {
    const estado = estadoDesdeError({ code: TIMEOUT, message: "" });
    expect(estado.causa).toBe("timeout");
  });

  it("mapea otros errores", () => {
    const estado = estadoDesdeError({ code: 2, message: "" });
    expect(estado.causa).toBe("otro");
  });
});

describe("obtenerUbicacion", () => {
  it("resuelve con las coordenadas cuando se concede el permiso (6.3)", async () => {
    const r = await obtenerUbicacion(geolocalizadorExito(36.72, -4.42));
    expect(r).toEqual({ ok: true, lat: 36.72, lon: -4.42 });
  });

  it("resuelve con error 'timeout' al agotarse el tiempo (6.5)", async () => {
    const r = await obtenerUbicacion(geolocalizadorError(TIMEOUT));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.estado.causa).toBe("timeout");
    }
  });

  it("propaga el timeout de 10 s a la API del navegador", async () => {
    const getCurrentPosition: GeolocalizadorMinimo["getCurrentPosition"] = vi.fn(
      (onSuccess) => onSuccess({ coords: { latitude: 0, longitude: 0 } }),
    );
    await obtenerUbicacion({ getCurrentPosition });
    const opciones = (getCurrentPosition as unknown as {
      mock: { calls: unknown[][] };
    }).mock.calls[0][2] as { timeout: number };
    expect(opciones.timeout).toBe(busLayerData.GEOLOCALIZACION_TIMEOUT_MS);
    expect(busLayerData.GEOLOCALIZACION_TIMEOUT_MS).toBe(10_000);
  });
});

describe("buscarParadasCercanas", () => {
  it("devuelve 'resultado' con las paradas cuando hay paradas cercanas (6.2)", async () => {
    vi.spyOn(busLayerData, "fetchParadasCercanas").mockResolvedValue([
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-4.42, 36.72] },
        properties: { codParada: "590", nombre: "P590", distanciaMetros: 100 },
      },
    ]);

    const estado = await buscarParadasCercanas(geolocalizadorExito(36.72, -4.42));
    expect(estado.tipo).toBe("resultado");
    if (estado.tipo === "resultado") {
      expect(estado.paradas).toHaveLength(1);
    }
  });

  it("devuelve 'vacio' cuando no hay paradas en 1000 m (6.6)", async () => {
    vi.spyOn(busLayerData, "fetchParadasCercanas").mockResolvedValue([]);

    const estado = await buscarParadasCercanas(geolocalizadorExito(36.72, -4.42));
    expect(estado.tipo).toBe("vacio");
  });

  it("devuelve error sin consultar paradas si se deniega el permiso (6.4)", async () => {
    const spy = vi.spyOn(busLayerData, "fetchParadasCercanas");

    const estado = await buscarParadasCercanas(
      geolocalizadorError(PERMISSION_DENIED),
    );
    expect(estado.tipo).toBe("error");
    if (estado.tipo === "error") {
      expect(estado.causa).toBe("denegado");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("emite los estados intermedios por onProgreso", async () => {
    vi.spyOn(busLayerData, "fetchParadasCercanas").mockResolvedValue([]);
    const estados: string[] = [];

    await buscarParadasCercanas(geolocalizadorExito(36.72, -4.42), {
      onProgreso: (e) => estados.push(e.tipo),
    });

    expect(estados).toEqual(["localizando", "buscando"]);
  });
});
