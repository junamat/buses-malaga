"use client";

/**
 * Panel de filtros del mapa por Línea y Sentido (capa de infraestructura del
 * `Frontend_Mapa`, Requisito 3).
 *
 * Es un componente de presentación controlado: no contiene lógica de filtrado
 * (esa vive en `lib/filters.ts` y se aplica en `MapaBase`). Aquí solo se
 * renderizan los controles —selección de una o varias Líneas, selección de
 * Sentido y acción de limpiar— y se notifican los cambios al contenedor:
 *
 * - **Línea (3.1)**: lista de casillas; se pueden marcar una o varias Líneas.
 *   El conjunto marcado se eleva vía `onLineasChange`.
 * - **Sentido (3.2)**: grupo de radios con las opciones de Sentido más "todos".
 *   El Sentido elegido (o `null`) se eleva vía `onSentidoChange`.
 * - **AND (3.3)**: ambos criterios se comunican de forma independiente; la
 *   composición con lógica AND la realiza `lib/filters.apply` en el contenedor.
 * - **Limpiar (3.4)**: `onClear` restablece el estado base (sin filtros); el
 *   contenedor restaura así la vista previa.
 * - **Sin resultados (3.5)**: `sinResultados` muestra un aviso sin tocar los
 *   controles, de modo que los filtros aplicados se conservan tal cual.
 *
 * Accesibilidad: el panel es una región etiquetada; las Líneas forman un grupo
 * (`group`) de casillas y los Sentidos un `radiogroup`, con etiquetas
 * asociadas, en línea con el `LayerSwitcher` existente.
 */

import { useId } from "react";

import type { CodLinea, Sentido } from "@/lib/types";
import type { LineaOpcion } from "./filterPanelData";

/** Opción de Sentido presentada en el control (además de "todos"). */
export interface SentidoOpcion {
  readonly sentido: Sentido;
  /** Etiqueta legible del Sentido (p. ej. "Ida", "Vuelta"). */
  readonly etiqueta: string;
  /**
   * Destino legible a mostrar junto al Sentido cuando existe para el conjunto
   * de Líneas seleccionadas (Requisito 2.8). Omitido cuando no hay Destino
   * aplicable: en ese caso se muestra solo el Sentido.
   */
  readonly destino?: string;
}

/**
 * Sentidos ofrecidos por defecto. La EMT modela dos sentidos por línea
 * (1 = ida, 2 = vuelta); se exponen como opciones legibles junto a "todos".
 */
export const SENTIDOS_POR_DEFECTO: readonly SentidoOpcion[] = [
  { sentido: 1, etiqueta: "Ida" },
  { sentido: 2, etiqueta: "Vuelta" },
] as const;

export interface FilterPanelProps {
  /** Catálogo de Líneas seleccionables (de `fetchLineas`). */
  readonly lineas: readonly LineaOpcion[];
  /** Conjunto de Líneas actualmente seleccionadas (filtro por Línea). */
  readonly lineasSeleccionadas: ReadonlySet<CodLinea>;
  /** Sentido actualmente seleccionado, o `null` si no se filtra por Sentido. */
  readonly sentidoSeleccionado: Sentido | null;
  /** Opciones de Sentido a presentar. Por defecto, ida y vuelta. */
  readonly sentidos?: readonly SentidoOpcion[];
  /** ¿La combinación de filtros activa no deja resultados? (Requisito 3.5). */
  readonly sinResultados: boolean;
  /** ¿Hay al menos un filtro activo? Controla el estado del botón "Limpiar". */
  readonly hayFiltrosActivos: boolean;
  /** `true` mientras se carga el catálogo de Líneas. */
  readonly cargandoLineas?: boolean;
  /** Notifica el nuevo conjunto de Líneas seleccionadas (Requisito 3.1). */
  readonly onLineasChange: (lineas: ReadonlySet<CodLinea>) => void;
  /** Notifica el nuevo Sentido seleccionado, o `null` (Requisito 3.2). */
  readonly onSentidoChange: (sentido: Sentido | null) => void;
  /** Limpia todos los filtros y restaura la vista base (Requisito 3.4). */
  readonly onClear: () => void;
}

/** Devuelve un conjunto nuevo con `codLinea` añadida o quitada (inmutable). */
function toggleLinea(
  seleccionadas: ReadonlySet<CodLinea>,
  codLinea: CodLinea,
  marcada: boolean,
): Set<CodLinea> {
  const siguiente = new Set(seleccionadas);
  if (marcada) {
    siguiente.add(codLinea);
  } else {
    siguiente.delete(codLinea);
  }
  return siguiente;
}

/** Etiqueta legible de una Línea: su nombre si existe, o su `codLinea`. */
function etiquetaLinea(linea: LineaOpcion): string {
  return linea.nombre !== undefined && linea.nombre !== ""
    ? `${linea.codLinea} · ${linea.nombre}`
    : `Línea ${linea.codLinea}`;
}

export default function FilterPanel({
  lineas,
  lineasSeleccionadas,
  sentidoSeleccionado,
  sentidos = SENTIDOS_POR_DEFECTO,
  sinResultados,
  hayFiltrosActivos,
  cargandoLineas = false,
  onLineasChange,
  onSentidoChange,
  onClear,
}: FilterPanelProps): JSX.Element {
  // Nombre único para el grupo de radios de Sentido (evita colisiones si el
  // panel se montara más de una vez).
  const sentidoGroupName = useId();

  return (
    <section
      aria-label="Filtros de líneas y sentido"
      style={{
        position: "absolute",
        top: 12,
        left: 12,
        zIndex: 1000,
        background: "#fff",
        color: "#222",
        borderRadius: 4,
        padding: 12,
        boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
        fontSize: 14,
        maxWidth: 240,
        maxHeight: "70vh",
        overflowY: "auto",
      }}
    >
      {/* Filtro por Línea (Requisito 3.1) */}
      <div role="group" aria-label="Filtrar por línea">
        <p style={{ margin: "0 0 6px", fontWeight: 600 }}>Líneas</p>
        {cargandoLineas ? (
          <p style={{ margin: 0, color: "#555" }}>Cargando líneas…</p>
        ) : lineas.length === 0 ? (
          <p style={{ margin: 0, color: "#555" }}>No hay líneas disponibles.</p>
        ) : (
          <div style={{ maxHeight: 180, overflowY: "auto" }}>
            {lineas.map((linea) => {
              const checked = lineasSeleccionadas.has(linea.codLinea);
              return (
                <label
                  key={`linea-${linea.codLinea}`}
                  style={{
                    display: "block",
                    cursor: "pointer",
                    padding: "2px 0",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) =>
                      onLineasChange(
                        toggleLinea(
                          lineasSeleccionadas,
                          linea.codLinea,
                          event.target.checked,
                        ),
                      )
                    }
                    style={{ marginRight: 6 }}
                  />
                  {etiquetaLinea(linea)}
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* Filtro por Sentido (Requisito 3.2) */}
      <div
        role="radiogroup"
        aria-label="Filtrar por sentido"
        style={{ marginTop: 10 }}
      >
        <p style={{ margin: "0 0 6px", fontWeight: 600 }}>Sentido</p>
        <label style={{ display: "block", cursor: "pointer", padding: "2px 0" }}>
          <input
            type="radio"
            name={sentidoGroupName}
            checked={sentidoSeleccionado === null}
            onChange={() => onSentidoChange(null)}
            style={{ marginRight: 6 }}
          />
          Todos
        </label>
        {sentidos.map((opcion) => (
          <label
            key={`sentido-${opcion.sentido}`}
            style={{ display: "block", cursor: "pointer", padding: "2px 0" }}
          >
            <input
              type="radio"
              name={sentidoGroupName}
              checked={sentidoSeleccionado === opcion.sentido}
              onChange={() => onSentidoChange(opcion.sentido)}
              style={{ marginRight: 6 }}
            />
            {/* Requisito 2.8: se muestra el Destino real junto al Sentido
                cuando existe; en su ausencia, solo el Sentido ("Ida"/"Vuelta"). */}
            {opcion.destino !== undefined
              ? `${opcion.etiqueta} · ${opcion.destino}`
              : opcion.etiqueta}
          </label>
        ))}
      </div>

      {/* Limpiar filtros (Requisito 3.4) */}
      <button
        type="button"
        onClick={onClear}
        disabled={!hayFiltrosActivos}
        style={{
          marginTop: 12,
          width: "100%",
          padding: "6px 8px",
          cursor: hayFiltrosActivos ? "pointer" : "default",
          background: hayFiltrosActivos ? "#1565c0" : "#cfd8dc",
          color: hayFiltrosActivos ? "#fff" : "#789",
          border: "none",
          borderRadius: 4,
          fontSize: 14,
        }}
      >
        Limpiar filtros
      </button>

      {/* Aviso de combinación sin resultados (Requisito 3.5). No altera los
          controles: los filtros aplicados se conservan tal cual. */}
      {sinResultados ? (
        <p
          role="status"
          style={{
            margin: "10px 0 0",
            padding: "6px 8px",
            background: "#8a6d00",
            color: "#fff",
            borderRadius: 4,
          }}
        >
          Ningún bus ni parada coincide con los filtros seleccionados.
        </p>
      ) : null}
    </section>
  );
}
