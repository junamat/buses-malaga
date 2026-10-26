import { describe, it, expect } from "vitest";

import {
  parseCodLineas,
  parseSentido,
  parseCodLineaUnica,
  parsePaginacion,
  isApiError,
} from "@/lib/apiQuery";
import { API_ERROR_CODES } from "@/lib/apiErrors";

/** Construye `URLSearchParams` a partir de un query string sin el `?`. */
function qs(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

// ---------------------------------------------------------------------------
// parseCodLineas (conjunto de líneas, repetición y lista por comas)
// ---------------------------------------------------------------------------

describe("parseCodLineas", () => {
  it("devuelve undefined cuando el parámetro no aparece", () => {
    expect(parseCodLineas(qs(""))).toBeUndefined();
  });

  it("parsea un único valor entero", () => {
    expect(parseCodLineas(qs("codLinea=7"))).toEqual([7]);
  });

  it("une valores repetidos del parámetro", () => {
    expect(parseCodLineas(qs("codLinea=1&codLinea=7"))).toEqual([1, 7]);
  });

  it("acepta listas separadas por comas", () => {
    expect(parseCodLineas(qs("codLinea=1,7,13"))).toEqual([1, 7, 13]);
  });

  it("combina repetición y comas", () => {
    expect(parseCodLineas(qs("codLinea=1,7&codLinea=13"))).toEqual([1, 7, 13]);
  });

  it("tolera comas sobrantes sin tratarlas como error", () => {
    expect(parseCodLineas(qs("codLinea=1,"))).toEqual([1]);
  });

  it("trata un valor vacío como ausencia de filtro", () => {
    expect(parseCodLineas(qs("codLinea="))).toBeUndefined();
  });

  it("devuelve un error 400 si algún valor no es entero (11.8)", () => {
    const result = parseCodLineas(qs("codLinea=abc"));
    expect(isApiError(result)).toBe(true);
    if (isApiError(result)) {
      expect(result.status).toBe(400);
      expect(result.body.code).toBe(API_ERROR_CODES.malformedRequest);
    }
  });

  it("rechaza valores decimales como malformados", () => {
    const result = parseCodLineas(qs("codLinea=1.5"));
    expect(isApiError(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseSentido
// ---------------------------------------------------------------------------

describe("parseSentido", () => {
  it("devuelve undefined cuando no aparece o está vacío", () => {
    expect(parseSentido(qs(""))).toBeUndefined();
    expect(parseSentido(qs("sentido="))).toBeUndefined();
  });

  it("parsea un entero válido", () => {
    expect(parseSentido(qs("sentido=2"))).toBe(2);
  });

  it("devuelve un error 400 si no es entero (11.8)", () => {
    const result = parseSentido(qs("sentido=ida"));
    expect(isApiError(result)).toBe(true);
    if (isApiError(result)) {
      expect(result.status).toBe(400);
      expect(result.body.code).toBe(API_ERROR_CODES.malformedRequest);
    }
  });
});

// ---------------------------------------------------------------------------
// parseCodLineaUnica
// ---------------------------------------------------------------------------

describe("parseCodLineaUnica", () => {
  it("devuelve undefined cuando no aparece", () => {
    expect(parseCodLineaUnica(qs(""))).toBeUndefined();
  });

  it("devuelve el único valor", () => {
    expect(parseCodLineaUnica(qs("codLinea=7"))).toBe(7);
  });

  it("usa el primero cuando hay varios", () => {
    expect(parseCodLineaUnica(qs("codLinea=1,7"))).toBe(1);
  });

  it("propaga el error de un valor malformado", () => {
    const result = parseCodLineaUnica(qs("codLinea=x"));
    expect(isApiError(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parsePaginacion
// ---------------------------------------------------------------------------

describe("parsePaginacion", () => {
  it("devuelve un objeto vacío sin parámetros de paginación", () => {
    expect(parsePaginacion(qs(""))).toEqual({});
  });

  it("parsea limite y cursor", () => {
    expect(parsePaginacion(qs("limite=50&cursor=200"))).toEqual({
      limite: 50,
      cursor: "200",
    });
  });

  it("no incluye cursor cuando está vacío", () => {
    expect(parsePaginacion(qs("cursor="))).toEqual({});
  });

  it("devuelve un error 400 si limite no es entero (11.8)", () => {
    const result = parsePaginacion(qs("limite=muchos"));
    expect(isApiError(result)).toBe(true);
    if (isApiError(result)) {
      expect(result.status).toBe(400);
      expect(result.body.code).toBe(API_ERROR_CODES.malformedRequest);
    }
  });

  it("no valida el rango de limite (lo recorta el repositorio)", () => {
    // 10000 es sintácticamente válido; el recorte a <=200 es responsabilidad
    // del repositorio, no del parsing.
    expect(parsePaginacion(qs("limite=10000"))).toEqual({ limite: 10000 });
  });
});
