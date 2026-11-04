"use client";

/**
 * Botón ☆/★ para marcar o desmarcar una Parada, una Linea o una combinación
 * Parada+Linea como favorito (tarea 15.2, Requisitos 8.1–8.3, 8.7). Sin sesión,
 * pide iniciar sesión (7.6).
 */

import { useState } from "react";

import type { ReferenciaFavorito } from "@/lib/favorites";
import { useUser } from "./UserContext";

export default function FavoritoButton({
  referencia,
  etiqueta,
}: {
  referencia: ReferenciaFavorito;
  etiqueta: string;
}): JSX.Element {
  const { favoritoDe, alternarFavorito } = useUser();
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const marcado = favoritoDe(referencia) !== undefined;

  async function onClick(): Promise<void> {
    setOcupado(true);
    setError(await alternarFavorito(referencia));
    setOcupado(false);
  }

  return (
    <span style={{ display: "block", marginTop: 4 }}>
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={ocupado}
        aria-pressed={marcado}
        style={{ cursor: "pointer", border: "none", background: "none", padding: 0, color: "#0d47a1", fontSize: 13 }}
      >
        {marcado ? "★" : "☆"} {etiqueta}
      </button>
      {error !== null ? <span style={{ display: "block", color: "#b00020" }}>{error}</span> : null}
    </span>
  );
}
