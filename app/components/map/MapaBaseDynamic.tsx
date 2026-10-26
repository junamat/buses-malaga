"use client";

/**
 * Carga dinámica del componente de mapa con `ssr: false` (capa de
 * infraestructura).
 *
 * Leaflet accede a `window`/`document` en el momento de importarse, por lo que
 * no puede ejecutarse en el servidor (SSR de Next.js). Este wrapper usa
 * `next/dynamic` con `ssr: false` para cargar `MapaBase` solo en el cliente,
 * mostrando un marcador de posición mientras se monta.
 */

import dynamic from "next/dynamic";

const MapaBase = dynamic(() => import("./MapaBase"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#555",
      }}
    >
      Cargando mapa…
    </div>
  ),
});

export default MapaBase;
