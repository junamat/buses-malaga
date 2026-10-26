/**
 * Geolocalización de paradas cercanas en el cliente (tarea 10.3, Requisito 6).
 *
 * Encapsula la interacción con la API de geolocalización del navegador y la
 * máquina de estados de la búsqueda de paradas cercanas, de modo que el
 * componente de mapa solo renderice el estado resultante. Los estados cubren
 * explícitamente todos los caminos del Requisito 6:
 *
 * - 6.1: se solicita permiso al usuario.
 * - 6.3: concesión → se obtiene la ubicación y se consultan paradas cercanas.
 * - 6.4: denegación → mensaje claro, sin bloquear el mapa.
 * - 6.5: timeout de 10 s → estado de error por tiempo agotado.
 * - 6.2/6.6: hasta 10 paradas en 1000 m con su distancia en metros.
 * - "sin paradas en 1000 m" → estado vacío diferenciado.
 *
 * El acceso al navegador (`navigator.geolocation`) se inyecta para poder
 * verificar la lógica sin un entorno de navegador.
 */

import {
  fetchParadasCercanas,
  GEOLOCALIZACION_TIMEOUT_MS,
  type ParadaCercanaFeature,
} from "./busLayerData";

/** Estado de la búsqueda de paradas cercanas por geolocalización. */
export type EstadoGeolocalizacion =
  | { tipo: "inactivo" }
  /** Pidiendo permiso / obteniendo ubicación (Requisito 6.1). */
  | { tipo: "localizando" }
  /** Ubicación obtenida; consultando paradas cercanas. */
  | { tipo: "buscando"; lat: number; lon: number }
  /** Paradas encontradas (hasta 10 en 1000 m, Requisitos 6.2, 6.6). */
  | { tipo: "resultado"; paradas: readonly ParadaCercanaFeature[] }
  /** No hay paradas dentro de 1000 m (Requisito 6.6). */
  | { tipo: "vacio" }
  /** Error: permiso denegado, timeout (6.5) u otro fallo (6.4). */
  | { tipo: "error"; motivo: string; causa: "denegado" | "timeout" | "otro" };

/** Subconjunto de `navigator.geolocation` que necesita este módulo. */
export interface GeolocalizadorMinimo {
  getCurrentPosition(
    onSuccess: (pos: { coords: { latitude: number; longitude: number } }) => void,
    onError: (err: { code: number; message: string }) => void,
    opciones?: { enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
  ): void;
}

/** Código de error de permiso denegado de la API de geolocalización. */
export const PERMISSION_DENIED = 1;
/** Código de error de timeout de la API de geolocalización. */
export const TIMEOUT = 3;

/** Traduce un error de la API de geolocalización al estado de error del dominio. */
export function estadoDesdeError(err: {
  code: number;
  message: string;
}): Extract<EstadoGeolocalizacion, { tipo: "error" }> {
  if (err.code === PERMISSION_DENIED) {
    return {
      tipo: "error",
      causa: "denegado",
      motivo:
        "Permiso de ubicación denegado. Actívalo para ver las paradas cercanas.",
    };
  }
  if (err.code === TIMEOUT) {
    return {
      tipo: "error",
      causa: "timeout",
      motivo: "Se agotó el tiempo para obtener tu ubicación (10 s).",
    };
  }
  return {
    tipo: "error",
    causa: "otro",
    motivo: "No se pudo obtener tu ubicación.",
  };
}

/**
 * Obtiene la ubicación del usuario con el timeout de 10 s (Requisito 6.5),
 * resolviendo con las coordenadas o con el estado de error correspondiente
 * (denegación 6.4, timeout 6.5). No lanza: siempre resuelve.
 */
export function obtenerUbicacion(
  geolocalizador: GeolocalizadorMinimo,
  timeoutMs: number = GEOLOCALIZACION_TIMEOUT_MS,
): Promise<
  | { ok: true; lat: number; lon: number }
  | { ok: false; estado: Extract<EstadoGeolocalizacion, { tipo: "error" }> }
> {
  return new Promise((resolve) => {
    geolocalizador.getCurrentPosition(
      (pos) =>
        resolve({
          ok: true,
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        }),
      (err) => resolve({ ok: false, estado: estadoDesdeError(err) }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

/**
 * Flujo completo de búsqueda de paradas cercanas: obtiene la ubicación y
 * consulta el endpoint, devolviendo el estado final (`resultado`, `vacio` o
 * `error`). `onProgreso` permite al llamador reflejar los estados intermedios
 * (`localizando` → `buscando`). No lanza.
 */
export async function buscarParadasCercanas(
  geolocalizador: GeolocalizadorMinimo,
  opciones: {
    timeoutMs?: number;
    signal?: AbortSignal;
    onProgreso?: (estado: EstadoGeolocalizacion) => void;
  } = {},
): Promise<EstadoGeolocalizacion> {
  const { timeoutMs, signal, onProgreso } = opciones;

  onProgreso?.({ tipo: "localizando" });
  const ubicacion = await obtenerUbicacion(geolocalizador, timeoutMs);
  if (!ubicacion.ok) {
    return ubicacion.estado;
  }

  const { lat, lon } = ubicacion;
  onProgreso?.({ tipo: "buscando", lat, lon });

  try {
    const paradas = await fetchParadasCercanas(lat, lon, signal);
    if (paradas.length === 0) {
      return { tipo: "vacio" };
    }
    return { tipo: "resultado", paradas };
  } catch {
    return {
      tipo: "error",
      causa: "otro",
      motivo: "No se pudieron obtener las paradas cercanas.",
    };
  }
}
