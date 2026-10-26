"use client";

/**
 * Componente de mapa base (`Frontend_Mapa`, capa de infraestructura).
 *
 * Renderiza Leaflet + teselas de OpenStreetMap centrado en el área de servicio
 * de la EMT de Málaga y proyecta sobre Leaflet el estado puro de
 * `lib/mapState.ts`. Toda la lógica de capas, zoom y centro se delega en ese
 * módulo puro; este componente solo traduce el estado a Leaflet y los eventos
 * de Leaflet de vuelta al estado.
 *
 * Requisitos cubiertos aquí:
 * - 1.1: mapa interactivo centrado en el área de la EMT con teselas OSM.
 * - 1.3: zoom inicial en [10, 16] y una única capa base activa por defecto.
 * - 1.5: si las teselas de la capa seleccionada fallan, conservar la capa base
 *   previa y mostrar una indicación de error.
 * - 2.1, 2.2: pinta cada Bus en su posición con su `codLinea` y `sentido`.
 * - 2.3, 2.4: pinta las Paradas en sus coordenadas; al seleccionar una muestra
 *   su `nombre` legible y su `codParada`.
 * - 2.5: refresca las posiciones cada minuto con la captura más reciente (la
 *   API ya resuelve la captura más reciente por bus).
 * - 2.6: indica al usuario cuándo no hay buses que mostrar.
 * - 2.7: marca los datos obsoletos indicando su antigüedad.
 * - 3.1–3.5: panel de filtros por Línea y Sentido. Los buses y paradas se
 *   cargan sin filtrar (conjunto base) y el filtrado se aplica en el cliente
 *   con la lógica pura de `lib/filters.ts` (vía `./applyFilters`): filtro por
 *   Línea sobre Buses y Paradas (3.1), por Sentido sobre Buses (3.2),
 *   composición AND (3.3), limpieza que restaura la vista base (3.4) y aviso de
 *   combinación sin resultados conservando el estado de los filtros (3.5).
 *
 * La lógica pura (Requisitos 1.2, 1.4, 1.6: exactamente una capa activa,
 * conmutar preserva centro/zoom, recorte del zoom a [1, 19]) vive en
 * `lib/mapState.ts` y se consume vía `createMapState`, `switchLayer`,
 * `setZoom`, `panTo` y `activeLayer`. La obtención de datos y la lógica pura de
 * obsolescencia (Requisito 2.7) viven en `./busLayerData`. La semántica de los
 * filtros (Requisito 3) vive en `lib/filters.ts`; `./FilterPanel` es el control
 * de presentación y `./applyFilters` el puente feature↔dominio.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleMarker,
  MapContainer,
  Popup,
  TileLayer,
  Tooltip,
  useMapEvents,
} from "react-leaflet";
import type { LatLngBoundsExpression } from "leaflet";
import "leaflet/dist/leaflet.css";

import {
  activeLayer,
  createMapState,
  MAX_ZOOM,
  MIN_ZOOM,
  panTo,
  setZoom,
  switchLayer,
  type LayerId,
  type MapState,
} from "@/lib/mapState";
import {
  BASE_LAYERS,
  DEFAULT_LAYER_ID,
  tileConfigFor,
} from "./baseLayers";
import { EMT_MALAGA_CENTER, INITIAL_ZOOM } from "./mapConfig";
import {
  describeStaleness,
  fetchBuses,
  fetchParadas,
  type BusFeature,
  type ParadaFeature,
} from "./busLayerData";
import {
  EMPTY_FILTER_STATE,
  clear,
  hasActiveFilters,
  withLineas,
  withSentido,
  type FilterState,
  type ParadaLineasLookup,
} from "@/lib/filters";
import type { CodLinea, Sentido } from "@/lib/types";
import { applyFilters } from "./applyFilters";
import {
  fetchLineas,
  fetchParadaLineasLookup,
  type LineaOpcion,
} from "./filterPanelData";
import FilterPanel from "./FilterPanel";

/**
 * Intervalo de refresco de las posiciones de buses, en milisegundos. Coincide
 * con la resolución de refresco de 1 minuto del sistema (Requisito 2.5 / 12.1).
 */
const BUS_REFRESH_MS = 60_000;

/**
 * Sincroniza los gestos de pan/zoom de Leaflet con el estado puro (Requisito
 * 1.6). Leaflet usa el orden `[lat, lon]`; el dominio usa `[lon, lat]`, de modo
 * que la conversión se hace aquí al leer el centro de Leaflet.
 */
function ViewSync({
  onPan,
  onZoom,
}: {
  onPan: (center: { lon: number; lat: number }) => void;
  onZoom: (zoom: number) => void;
}): null {
  useMapEvents({
    moveend(event) {
      const center = event.target.getCenter();
      onPan({ lon: center.lng, lat: center.lat });
    },
    zoomend(event) {
      onZoom(event.target.getZoom());
    },
  });
  return null;
}

/**
 * Estado de las capas de datos (buses y paradas) gestionado por el hook de
 * refresco. Las paradas son datos estáticos y se cargan una sola vez; los buses
 * se refrescan periódicamente.
 */
interface DataLayerState {
  buses: readonly BusFeature[];
  paradas: readonly ParadaFeature[];
  /** `true` hasta que concluye la primera carga de buses. */
  cargando: boolean;
  /** Mensaje de error de red de la última carga de buses, si la hubo. */
  error: string | null;
}

/**
 * Hook que carga las paradas una vez y refresca las posiciones de buses cada
 * minuto (Requisito 2.5), consumiendo la API vía `./busLayerData`. Devuelve el
 * estado de las capas para que el componente lo proyecte sobre Leaflet.
 *
 * El refresco usa `setInterval`; cada ejecución aborta la petición anterior en
 * curso para no solapar cargas. Al desmontar se limpian el temporizador y la
 * petición pendiente. Un fallo de red conserva los datos previos (degradación
 * elegante) y expone el mensaje de error.
 */
function useBusStopLayers(): DataLayerState {
  const [buses, setBuses] = useState<readonly BusFeature[]>([]);
  const [paradas, setParadas] = useState<readonly ParadaFeature[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    let enCurso: AbortController | null = null;

    const refrescarBuses = async (): Promise<void> => {
      // Aborta cualquier refresco anterior aún en vuelo para no solaparlos.
      enCurso?.abort();
      const controller = new AbortController();
      enCurso = controller;
      try {
        const features = await fetchBuses(undefined, controller.signal);
        if (cancelado || controller.signal.aborted) {
          return;
        }
        setBuses(features);
        setError(null);
      } catch (err) {
        if (cancelado || controller.signal.aborted) {
          return;
        }
        // Un fallo de red conserva las posiciones previas (no se vacían).
        setError(
          err instanceof Error
            ? err.message
            : "No se pudieron actualizar las posiciones de los buses.",
        );
      } finally {
        if (!cancelado && !controller.signal.aborted) {
          setCargando(false);
        }
      }
    };

    // Carga inicial de paradas (datos estáticos: una sola vez).
    const paradasController = new AbortController();
    fetchParadas(undefined, paradasController.signal)
      .then((features) => {
        if (!cancelado) {
          setParadas(features);
        }
      })
      .catch(() => {
        // Las paradas son estáticas; un fallo aquí no bloquea las capas de
        // buses. Se omite silenciosamente y el resto del mapa sigue operativo.
      });

    // Primera carga de buses inmediata y refresco cada minuto (Requisito 2.5).
    void refrescarBuses();
    const timer = setInterval(() => {
      void refrescarBuses();
    }, BUS_REFRESH_MS);

    return () => {
      cancelado = true;
      clearInterval(timer);
      enCurso?.abort();
      paradasController.abort();
    };
  }, []);

  return { buses, paradas, cargando, error };
}

/**
 * Hook que carga una sola vez el catálogo de Líneas seleccionables del panel de
 * filtros (`GET /api/lineas`, vía `./filterPanelData`). Devuelve la lista y un
 * indicador de carga. Un fallo de red deja la lista vacía (el panel lo indica)
 * sin bloquear el resto del mapa.
 */
function useLineasCatalogo(): {
  lineas: readonly LineaOpcion[];
  cargando: boolean;
} {
  const [lineas, setLineas] = useState<readonly LineaOpcion[]>([]);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetchLineas(controller.signal)
      .then((opciones) => {
        if (!controller.signal.aborted) {
          setLineas(opciones);
        }
      })
      .catch(() => {
        // Un fallo al cargar el catálogo deja la lista vacía; el panel muestra
        // "no hay líneas disponibles" y el mapa sigue operativo.
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setCargando(false);
        }
      });
    return () => controller.abort();
  }, []);

  return { lineas, cargando };
}

/**
 * Hook que resuelve la consulta pura Parada → Líneas (`ParadaLineasLookup`)
 * para el conjunto de Líneas seleccionadas, necesaria para que el filtro por
 * Línea del Requisito 3.1 también oculte las Paradas no servidas por esas
 * Líneas. La asociación se obtiene vía `./filterPanelData` consultando las
 * Paradas de cada Línea seleccionada; se recalcula al cambiar la selección.
 *
 * Mientras no hay Líneas seleccionadas (o mientras se resuelve el lookup) se
 * devuelve un lookup vacío; en ese caso `applyFilters` no filtra Paradas por
 * Línea y el lookup no llega a usarse.
 */
function useParadaLineasLookup(
  lineasSeleccionadas: ReadonlySet<CodLinea>,
): ParadaLineasLookup {
  const [lookup, setLookup] = useState<ParadaLineasLookup>(() => () => []);

  // Clave estable del conjunto de líneas para disparar la recarga solo cuando
  // cambia su contenido (no en cada render).
  const clave = useMemo(
    () => [...lineasSeleccionadas].sort((a, b) => a - b).join(","),
    [lineasSeleccionadas],
  );

  useEffect(() => {
    const codLineas = clave === "" ? [] : clave.split(",").map(Number);
    if (codLineas.length === 0) {
      setLookup(() => () => []);
      return;
    }
    const controller = new AbortController();
    fetchParadaLineasLookup(codLineas, controller.signal)
      .then((resuelto) => {
        if (!controller.signal.aborted) {
          // Se envuelve en una función para que `setState` lo trate como valor.
          setLookup(() => resuelto);
        }
      })
      .catch(() => {
        // Si falla, se conserva un lookup vacío: las Paradas no superan el
        // filtro por Línea, coherente con "sin asociación conocida".
      });
    return () => controller.abort();
  }, [clave]);

  return lookup;
}

/**
 * Capa de marcadores de Buses y Paradas sobre Leaflet (Requisitos 2.1–2.4).
 *
 * - Buses: un `CircleMarker` por posición (`[lon, lat]` → `[lat, lon]`), con un
 *   `Tooltip` permanente que muestra `codLinea` y `sentido` (Requisitos 2.1,
 *   2.2). Los buses con posición obsoleta se atenúan visualmente (Requisito
 *   2.7).
 * - Paradas: un `CircleMarker` por coordenada; al seleccionarla (click) un
 *   `Popup` muestra el `nombre` legible y el `codParada` (Requisitos 2.3, 2.4).
 */
function BusStopMarkers({
  buses,
  paradas,
}: {
  buses: readonly BusFeature[];
  paradas: readonly ParadaFeature[];
}): JSX.Element {
  return (
    <>
      {paradas.map((parada) => {
        const [lon, lat] = parada.geometry.coordinates;
        const { codParada, nombre } = parada.properties;
        return (
          <CircleMarker
            key={`parada-${codParada}`}
            center={[lat, lon]}
            radius={4}
            pathOptions={{
              color: "#1565c0",
              weight: 1,
              fillColor: "#90caf9",
              fillOpacity: 0.9,
            }}
          >
            <Popup>
              <strong>{nombre}</strong>
              <br />
              <span>Parada {codParada}</span>
            </Popup>
          </CircleMarker>
        );
      })}

      {buses.map((bus) => {
        const [lon, lat] = bus.geometry.coordinates;
        const { codBus, codLinea, sentido, obsoleto } = bus.properties;
        return (
          <CircleMarker
            key={`bus-${codBus}`}
            center={[lat, lon]}
            radius={6}
            pathOptions={{
              color: obsoleto ? "#9e9e9e" : "#c62828",
              weight: 1,
              fillColor: obsoleto ? "#cfcfcf" : "#ef5350",
              fillOpacity: obsoleto ? 0.5 : 0.9,
            }}
          >
            <Tooltip direction="top" permanent>
              {`L${codLinea} · S${sentido}`}
            </Tooltip>
            <Popup>
              <strong>Línea {codLinea}</strong>
              <br />
              <span>Sentido {sentido}</span>
              <br />
              <span>Bus {codBus}</span>
            </Popup>
          </CircleMarker>
        );
      })}
    </>
  );
}

/** Límite del estado inicial del mapa construido con la lógica pura. */
function buildInitialState(): MapState {
  return createMapState({
    layers: BASE_LAYERS.map(({ id, nombre }) => ({ id, nombre })),
    activeLayerId: DEFAULT_LAYER_ID,
    center: EMT_MALAGA_CENTER,
    zoom: INITIAL_ZOOM,
  });
}

export default function MapaBase(): JSX.Element {
  const [state, setState] = useState<MapState>(buildInitialState);

  // Capas de datos: paradas (estáticas) y buses (refresco de 1 min; Req 2.5).
  // Se cargan SIN filtrar: constituyen el conjunto base sobre el que la lógica
  // pura de `lib/filters.ts` aplica los filtros en el cliente (Requisito 3).
  const { buses, paradas, cargando, error } = useBusStopLayers();

  // --- Estado y datos del panel de filtros (Requisito 3) -------------------
  // Estado de filtros (value object inmutable de `lib/filters.ts`): conjunto de
  // Líneas y Sentido seleccionados. Empieza vacío (sin filtros = vista base).
  const [filterState, setFilterState] =
    useState<FilterState>(EMPTY_FILTER_STATE);
  const { lineas: lineasCatalogo, cargando: cargandoLineas } =
    useLineasCatalogo();
  // Asociación Parada → Líneas para el filtro por Línea sobre Paradas (3.1).
  const paradaLineas = useParadaLineasLookup(filterState.lineas);

  // Aplicación de los filtros al conjunto base delegando en `lib/filters.apply`
  // (vía `applyFilters`): AND de Línea y Sentido (3.1–3.3) y detección de
  // combinación sin resultados conservando el estado (3.5).
  const filtrado = useMemo(
    () => applyFilters(filterState, buses, paradas, paradaLineas),
    [filterState, buses, paradas, paradaLineas],
  );
  const busesVisibles = filtrado.buses;
  const paradasVisibles = filtrado.paradas;

  // Transiciones del estado de filtros (inmutables; no mutan el estado previo).
  const handleLineasChange = useCallback((lineas: ReadonlySet<CodLinea>) => {
    setFilterState((prev) => withLineas(prev, lineas));
  }, []);
  const handleSentidoChange = useCallback((sentido: Sentido | null) => {
    setFilterState((prev) => withSentido(prev, sentido));
  }, []);
  // Limpiar restaura el estado base; con el mismo conjunto base, la vista
  // vuelve exactamente a la previa a cualquier filtro (Requisito 3.4).
  const handleClearFilters = useCallback(() => {
    setFilterState(clear());
  }, []);

  // Aviso de datos obsoletos con su antigüedad (Requisito 2.7). Se recalcula en
  // cada render contra el instante actual; la lógica pura vive en busLayerData.
  // Se evalúa sobre los buses visibles (los que el usuario está viendo).
  const stalenessMsg = describeStaleness(busesVisibles, Date.now());

  // Indicación de ausencia de buses una vez concluida la primera carga (Req 2.6).
  // Se mide sobre el conjunto base: "no hay buses que mostrar" describe la
  // ausencia de datos de origen, no una combinación de filtros sin resultados
  // (esto último lo señala el propio panel de filtros, Requisito 3.5).
  const sinBuses = !cargando && buses.length === 0;

  // Capa previa a conservar si la seleccionada falla al cargar (Requisito 1.5).
  const previousLayerIdRef = useRef<LayerId>(state.activeLayerId);
  // Capa cuyas teselas se intentan cargar actualmente: si falla esta, revertimos.
  const pendingLayerIdRef = useRef<LayerId | null>(null);
  const [tileError, setTileError] = useState<string | null>(null);

  const current = activeLayer(state);
  const tileConfig = tileConfigFor(current.id);

  const handleSwitchLayer = useCallback(
    (layerId: LayerId) => {
      setState((prev) => {
        if (layerId === prev.activeLayerId) {
          return prev;
        }
        // Recordamos la capa que estaba activa para poder volver a ella si las
        // teselas de la nueva capa no cargan (Requisito 1.5).
        previousLayerIdRef.current = prev.activeLayerId;
        pendingLayerIdRef.current = layerId;
        setTileError(null);
        return switchLayer(prev, layerId);
      });
    },
    [],
  );

  const handleTileLoad = useCallback(() => {
    // La capa pendiente cargó correctamente: deja de estar pendiente y se
    // convierte en la capa de referencia a conservar.
    if (pendingLayerIdRef.current !== null) {
      previousLayerIdRef.current = pendingLayerIdRef.current;
      pendingLayerIdRef.current = null;
    }
  }, []);

  const handleTileError = useCallback(() => {
    const pending = pendingLayerIdRef.current;
    // Solo revertimos si el fallo corresponde a una capa recién seleccionada;
    // errores aislados de teselas de la capa ya establecida no la descartan.
    if (pending === null) {
      return;
    }
    pendingLayerIdRef.current = null;
    const fallbackId = previousLayerIdRef.current;
    const failed = tileConfigFor(pending);
    setTileError(
      `No se pudieron cargar las teselas de "${failed?.nombre ?? pending}". ` +
        "Se mantiene la capa anterior.",
    );
    setState((prev) => switchLayer(prev, fallbackId));
  }, []);

  const handlePan = useCallback((center: { lon: number; lat: number }) => {
    setState((prev) => panTo(prev, center));
  }, []);

  const handleZoom = useCallback((zoom: number) => {
    setState((prev) => setZoom(prev, zoom));
  }, []);

  // Encuadre amplio del área de servicio de la EMT como límite de paneo suave.
  const maxBounds = useMemo<LatLngBoundsExpression>(
    () => [
      [36.6, -4.6],
      [36.85, -4.2],
    ],
    [],
  );

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <MapContainer
        // Leaflet espera [lat, lon]; el dominio guarda [lon, lat].
        center={[state.center.lat, state.center.lon]}
        zoom={state.zoom}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        maxBounds={maxBounds}
        scrollWheelZoom
        style={{ width: "100%", height: "100%" }}
      >
        {tileConfig !== undefined ? (
          <TileLayer
            // `key` fuerza el remontaje al conmutar de capa, de modo que los
            // handlers de carga/error apliquen a la capa recién seleccionada.
            key={current.id}
            url={tileConfig.url}
            attribution={tileConfig.attribution}
            maxZoom={tileConfig.maxZoom}
            eventHandlers={{
              load: handleTileLoad,
              tileerror: handleTileError,
            }}
          />
        ) : null}
        <ViewSync onPan={handlePan} onZoom={handleZoom} />
        <BusStopMarkers buses={busesVisibles} paradas={paradasVisibles} />
      </MapContainer>

      <FilterPanel
        lineas={lineasCatalogo}
        lineasSeleccionadas={filterState.lineas}
        sentidoSeleccionado={filterState.sentido}
        sinResultados={filtrado.sinResultados}
        hayFiltrosActivos={hasActiveFilters(filterState)}
        cargandoLineas={cargandoLineas}
        onLineasChange={handleLineasChange}
        onSentidoChange={handleSentidoChange}
        onClear={handleClearFilters}
      />

      {sinBuses ? (
        <div
          role="status"
          style={{
            position: "absolute",
            top: 12,
            // Desplazado a la derecha del panel de filtros (top-left) para no
            // solaparse con él.
            left: 264,
            zIndex: 1000,
            maxWidth: "50%",
            padding: "8px 12px",
            background: "#fff",
            color: "#222",
            borderRadius: 4,
            fontSize: 14,
            boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
          }}
        >
          No hay buses que mostrar.
        </div>
      ) : null}

      {stalenessMsg !== null ? (
        <div
          role="status"
          style={{
            position: "absolute",
            top: sinBuses ? 56 : 12,
            left: 264,
            zIndex: 1000,
            maxWidth: "50%",
            padding: "8px 12px",
            background: "#8a6d00",
            color: "#fff",
            borderRadius: 4,
            fontSize: 14,
            boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
          }}
        >
          {stalenessMsg}
        </div>
      ) : null}

      {error !== null ? (
        <div
          role="status"
          style={{
            position: "absolute",
            top: 12,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1000,
            maxWidth: "80%",
            padding: "6px 10px",
            background: "rgba(0,0,0,0.75)",
            color: "#fff",
            borderRadius: 4,
            fontSize: 13,
            boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
          }}
        >
          No se pudieron actualizar las posiciones; se muestran las últimas
          conocidas.
        </div>
      ) : null}

      <LayerSwitcher
        layers={state.layers}
        activeLayerId={state.activeLayerId}
        onSelect={handleSwitchLayer}
      />

      {tileError !== null ? (
        <div
          role="alert"
          style={{
            position: "absolute",
            left: "50%",
            bottom: 16,
            transform: "translateX(-50%)",
            zIndex: 1000,
            maxWidth: "90%",
            padding: "8px 12px",
            background: "#b00020",
            color: "#fff",
            borderRadius: 4,
            fontSize: 14,
            boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
          }}
        >
          {tileError}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Conmutador de capas base (Requisito 1.2). Presenta las capas disponibles y
 * marca la activa; la selección se delega en `switchLayer` a través de
 * `onSelect`.
 */
function LayerSwitcher({
  layers,
  activeLayerId,
  onSelect,
}: {
  layers: readonly { id: LayerId; nombre: string }[];
  activeLayerId: LayerId;
  onSelect: (layerId: LayerId) => void;
}): JSX.Element {
  return (
    <div
      aria-label="Conmutador de capas base"
      role="radiogroup"
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        zIndex: 1000,
        background: "#fff",
        borderRadius: 4,
        padding: 8,
        boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
        fontSize: 14,
      }}
    >
      {layers.map((layer) => {
        const checked = layer.id === activeLayerId;
        return (
          <label
            key={layer.id}
            style={{
              display: "block",
              cursor: "pointer",
              padding: "2px 0",
              color: "#222",
            }}
          >
            <input
              type="radio"
              name="base-layer"
              value={layer.id}
              checked={checked}
              onChange={() => onSelect(layer.id)}
              style={{ marginRight: 6 }}
            />
            {layer.nombre}
          </label>
        );
      })}
    </div>
  );
}
