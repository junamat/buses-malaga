import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  API_ERROR_CODES,
  type ApiError,
  ApiErrorException,
  notFound,
  malformedRequest,
  missingParams,
  findMissingParams,
  validateRequiredParams,
  toResponse,
} from "@/lib/apiErrors";

// ---------------------------------------------------------------------------
// Constructoras canónicas: estado HTTP y cuerpo { code, message }
// ---------------------------------------------------------------------------

describe("notFound", () => {
  it("responde 404 con el código canónico de recurso inexistente (11.7)", () => {
    const error = notFound();
    expect(error.status).toBe(404);
    expect(error.body.code).toBe(API_ERROR_CODES.notFound);
    expect(typeof error.body.message).toBe("string");
    expect(error.body.message.length).toBeGreaterThan(0);
    expect(error.body.params).toBeUndefined();
  });

  it("acepta un mensaje legible personalizado", () => {
    const error = notFound("La parada 9999 no existe.");
    expect(error.body.message).toBe("La parada 9999 no existe.");
    expect(error.status).toBe(404);
  });
});

describe("malformedRequest", () => {
  it("responde 400 indicando que la petición es incorrecta (11.8)", () => {
    const error = malformedRequest();
    expect(error.status).toBe(400);
    expect(error.body.code).toBe(API_ERROR_CODES.malformedRequest);
    expect(error.body.message.length).toBeGreaterThan(0);
    expect(error.body.params).toBeUndefined();
  });
});

describe("missingParams", () => {
  it("responde 400 e identifica los parámetros ausentes (11.9)", () => {
    const error = missingParams(["lat", "lon"]);
    expect(error.status).toBe(400);
    expect(error.body.code).toBe(API_ERROR_CODES.missingParams);
    expect(error.body.params).toEqual(["lat", "lon"]);
    // El mensaje también nombra los parámetros ausentes.
    expect(error.body.message).toContain("lat");
    expect(error.body.message).toContain("lon");
  });

  it("rechaza una lista vacía como error de programación", () => {
    expect(() => missingParams([])).toThrow();
  });

  it("hace copia defensiva: mutar la entrada no altera el cuerpo", () => {
    const entrada = ["codParada"];
    const error = missingParams(entrada);
    entrada.push("otro");
    expect(error.body.params).toEqual(["codParada"]);
  });
});

// ---------------------------------------------------------------------------
// Validación de parámetros obligatorios
// ---------------------------------------------------------------------------

describe("findMissingParams", () => {
  it("trata null, undefined y cadenas en blanco como ausentes", () => {
    const ausentes = findMissingParams(["a", "b", "c", "d", "e"], {
      a: "ok",
      b: null,
      c: undefined,
      d: "",
      e: "   ",
    });
    expect(ausentes).toEqual(["b", "c", "d", "e"]);
  });

  it("devuelve lista vacía cuando están todos presentes", () => {
    expect(findMissingParams(["lat", "lon"], { lat: "1", lon: "2" })).toEqual(
      [],
    );
  });

  it("conserva el orden declarado en required", () => {
    expect(findMissingParams(["lon", "lat"], {})).toEqual(["lon", "lat"]);
  });
});

describe("validateRequiredParams", () => {
  it("devuelve null cuando no falta ningún parámetro", () => {
    expect(
      validateRequiredParams(["lat", "lon"], { lat: "36.7", lon: "-4.4" }),
    ).toBeNull();
  });

  it("devuelve el ApiError de ausentes con la lista exacta (11.9)", () => {
    const error = validateRequiredParams(["lat", "lon"], { lat: "36.7" });
    expect(error).not.toBeNull();
    expect(error?.status).toBe(400);
    expect(error?.body.code).toBe(API_ERROR_CODES.missingParams);
    expect(error?.body.params).toEqual(["lon"]);
  });

  it("funciona con URLSearchParams.get (null ⇒ ausente)", () => {
    const sp = new URLSearchParams("lat=36.7");
    const error = validateRequiredParams(["lat", "lon"], {
      lat: sp.get("lat"),
      lon: sp.get("lon"),
    });
    expect(error?.body.params).toEqual(["lon"]);
  });
});

// ---------------------------------------------------------------------------
// Conversión al borde HTTP
// ---------------------------------------------------------------------------

describe("toResponse", () => {
  it("serializa el cuerpo canónico con el estado y el content-type JSON", async () => {
    const error = missingParams(["codParada"]);
    const response = toResponse(error);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body).toEqual(error.body);
  });
});

describe("ApiErrorException", () => {
  it("transporta el ApiError intacto para el flujo basado en throw", () => {
    const apiError = notFound("no está");
    const ex = new ApiErrorException(apiError);
    expect(ex).toBeInstanceOf(Error);
    expect(ex.apiError).toBe(apiError);
    expect(ex.message).toBe("no está");
  });
});

// ---------------------------------------------------------------------------
// Propiedades (fast-check) sobre el contrato canónico de errores
// ---------------------------------------------------------------------------

/** Nombres de parámetro plausibles (no en blanco). */
const paramName = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => s.trim().length > 0);

describe("propiedades del contrato de errores canónico", () => {
  it("todo error canónico tiene code y message no vacíos", () => {
    const anyError: fc.Arbitrary<ApiError> = fc.oneof(
      fc.constant(notFound()),
      fc.constant(malformedRequest()),
      fc
        .uniqueArray(paramName, { minLength: 1, maxLength: 6 })
        .map((names) => missingParams(names)),
    );
    fc.assert(
      fc.property(anyError, (error) => {
        expect(typeof error.body.code).toBe("string");
        expect(error.body.code.length).toBeGreaterThan(0);
        expect(typeof error.body.message).toBe("string");
        expect(error.body.message.length).toBeGreaterThan(0);
        expect([400, 404]).toContain(error.status);
      }),
    );
  });

  it("validateRequiredParams reporta exactamente los parámetros en blanco o ausentes", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(paramName, { minLength: 1, maxLength: 8 }),
        fc.func(fc.boolean()),
        (required, presente) => {
          // Para cada obligatorio, decidir si se provee con valor útil o no.
          const provided: Record<string, string | null> = {};
          const esperadosAusentes: string[] = [];
          for (const name of required) {
            if (presente(name)) {
              provided[name] = "valor";
            } else {
              provided[name] = null;
              esperadosAusentes.push(name);
            }
          }

          const error = validateRequiredParams(required, provided);
          if (esperadosAusentes.length === 0) {
            expect(error).toBeNull();
          } else {
            expect(error?.status).toBe(400);
            expect(error?.body.code).toBe(API_ERROR_CODES.missingParams);
            expect(error?.body.params).toEqual(esperadosAusentes);
          }
        },
      ),
    );
  });
});
