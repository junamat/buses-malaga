/**
 * Property test de las operaciones protegidas sin sesión (tarea 14.4).
 *
 * - Property 19: las operaciones protegidas sin sesión se rechazan sin mutar
 *   datos. Validates: Requirement 7.6.
 *
 * Se ejercitan los cuatro handlers protegidos reales con un `AuthProvider` que
 * nunca autentica y un repositorio espía: para cualquier cuerpo/parámetros
 * válidos, la respuesta es `401`, el cuerpo enviado vuelve intacto en `datos` y
 * el repositorio no recibe ninguna llamada.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";

import type { AuthProvider, Repository, VerificacionSesion } from "@/lib/ports";
import { API_ERROR_CODES } from "@/lib/apiErrors";

const repo = {
  findParada: vi.fn(),
  existeLinea: vi.fn(),
  existeBus: vi.fn(),
  listFavoritos: vi.fn(),
  createFavorito: vi.fn(),
  deleteFavorito: vi.fn(),
  listAportacionesVigentes: vi.fn(),
  createAportacion: vi.fn(),
} satisfies Partial<Repository>;

const sinSesion: AuthProvider = {
  login: vi.fn(),
  logout: vi.fn(),
  verificarSesion: vi.fn(
    async (token: string | null | undefined): Promise<VerificacionSesion> =>
      token
        ? { autenticado: false, motivo: "sesion_invalida" }
        : { autenticado: false, motivo: "sin_sesion" },
  ),
  resolverUserId: vi.fn(async () => null),
};

vi.mock("@/lib/apiRepository", () => ({ getRepository: () => repo }));
vi.mock("@/lib/apiAuth", () => ({ getAuthProvider: () => sinSesion }));

import { extraerToken, SESSION_COOKIE } from "@/lib/auth";
import * as favoritos from "@/app/api/favoritos/route";
import * as favorito from "@/app/api/favoritos/[id]/route";
import * as aportaciones from "@/app/api/buses/[codBus]/aportaciones/route";

beforeEach(() => {
  for (const fn of Object.values(repo)) fn.mockReset();
});

const arbToken = fc.option(fc.stringMatching(/^[A-Za-z0-9._-]{1,40}$/), { nil: undefined });
const arbFavorito = fc.oneof(
  fc.record({ tipo: fc.constant("parada"), codParada: fc.stringMatching(/^[0-9]{1,4}$/) }),
  fc.record({ tipo: fc.constant("linea"), codLinea: fc.integer({ min: 1, max: 200 }) }),
);

function peticion(method: string, url: string, token: string | undefined, body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function esperar401(res: Response, datos?: unknown): Promise<void> {
  expect(res.status).toBe(401);
  const cuerpo = await res.json();
  expect(cuerpo.code).toBe(API_ERROR_CODES.sessionRequired);
  if (datos !== undefined) expect(cuerpo.datos).toEqual(datos);
  for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
}

describe("Property 19: operaciones protegidas sin sesión", () => {
  it("POST /api/favoritos se rechaza y devuelve los datos intactos", async () => {
    await fc.assert(
      fc.asyncProperty(arbToken, arbFavorito, async (token, body) => {
        const res = await favoritos.POST(peticion("POST", "http://x/api/favoritos", token, body));
        await esperar401(res, body);
      }),
      { numRuns: 100 },
    );
  });

  it("GET /api/favoritos y DELETE /api/favoritos/{id} se rechazan sin tocar el repositorio", async () => {
    await fc.assert(
      fc.asyncProperty(arbToken, fc.uuid(), async (token, id) => {
        await esperar401(await favoritos.GET(peticion("GET", "http://x/api/favoritos", token)));
        await esperar401(
          await favorito.DELETE(peticion("DELETE", `http://x/api/favoritos/${id}`, token), { params: { id } }),
        );
      }),
      { numRuns: 100 },
    );
  });

  it("POST /api/buses/{codBus}/aportaciones se rechaza y devuelve los datos intactos", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbToken,
        fc.integer({ min: 1, max: 99999 }),
        fc.record({ opcion: fc.string() }),
        async (token, codBus, body) => {
          const res = await aportaciones.POST(
            peticion("POST", `http://x/api/buses/${codBus}/aportaciones`, token, body),
            { params: { codBus: String(codBus) } },
          );
          await esperar401(res, body);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("extraerToken", () => {
  it("lee Authorization Bearer y, si falta, la cookie de sesión", () => {
    expect(extraerToken(new Request("http://x", { headers: { authorization: "Bearer abc" } }))).toBe("abc");
    expect(
      extraerToken(new Request("http://x", { headers: { cookie: `otra=1; ${SESSION_COOKIE}=t%3D1` } })),
    ).toBe("t=1");
    expect(extraerToken(new Request("http://x"))).toBeNull();
    expect(extraerToken(new Request("http://x", { headers: { authorization: "Basic abc" } }))).toBeNull();
  });
});
