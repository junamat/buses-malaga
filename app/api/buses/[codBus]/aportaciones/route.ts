/**
 * `GET/POST /api/buses/{codBus}/aportaciones` — aportaciones por vehículo
 * (tarea 15.1).
 *
 * - `GET` (público): `200 { codBus, opciones, aportaciones }` con las
 *   aportaciones vigentes (≤ 60 min) del vehículo y el catálogo de opciones
 *   (9.2, 9.3, 9.6). No expone qué usuario hizo cada aportación. `404` si el
 *   `codBus` no es un vehículo conocido (11.7).
 * - `POST` (requiere sesión, 7.6) con `{ opcion }`: `201 { aportacion }` (9.1);
 *   `422` si la opción no está en el catálogo, sin persistir (9.5); `404` si el
 *   `codBus` es desconocido (9.4); `400` si el cuerpo es malformado o falta
 *   `opcion` (11.8, 11.9).
 */

import { NextResponse } from "next/server";

import {
  malformedRequest,
  missingParams,
  notFound,
  toResponse,
  unprocessable,
} from "@/lib/apiErrors";
import { isApiError, parseCodBus, parseJsonBody } from "@/lib/apiQuery";
import { getAuthProvider } from "@/lib/apiAuth";
import { getRepository } from "@/lib/apiRepository";
import { conSesion } from "@/lib/auth";
import {
  OPCIONES_APORTACION,
  consultarAportaciones,
  etiquetaOpcion,
  expiraEn,
  registrarAportacion,
} from "@/lib/contributions";
import type { Aportacion } from "@/lib/types";

interface RouteContext {
  params: { codBus: string };
}

/** Representación pública de una aportación (sin el `userId` del autor). */
function aportacionPublica(a: Aportacion) {
  return {
    id: a.id,
    codBus: a.codBus,
    opcion: a.opcion,
    etiqueta: etiquetaOpcion(a.opcion),
    created_at: a.created_at,
    expiraEn: expiraEn(a),
  };
}

function busDesconocido(codBus: number): Response {
  return toResponse(notFound(`No existe ningún vehículo con codBus ${codBus}.`));
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const codBus = parseCodBus(context.params?.codBus);
  if (isApiError(codBus)) {
    return toResponse(codBus);
  }
  const repository = getRepository();
  if (!(await repository.existeBus(codBus))) {
    return busDesconocido(codBus);
  }
  const aportaciones = await consultarAportaciones(repository, codBus);
  return NextResponse.json({
    codBus,
    opciones: OPCIONES_APORTACION,
    aportaciones: aportaciones.map(aportacionPublica),
  });
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const codBus = parseCodBus(context.params?.codBus);
  if (isApiError(codBus)) {
    return toResponse(codBus);
  }
  const cuerpo = await parseJsonBody(request);
  if (isApiError(cuerpo)) {
    return toResponse(cuerpo);
  }
  const { datos } = cuerpo;

  return conSesion(
    request,
    getAuthProvider(),
    async ({ userId }) => {
      if (typeof datos !== "object" || datos === null || Array.isArray(datos)) {
        return toResponse(malformedRequest("El cuerpo debe ser un objeto JSON."));
      }
      const { opcion } = datos as { opcion?: unknown };
      if (opcion === undefined || opcion === null || opcion === "") {
        return toResponse(missingParams(["opcion"]));
      }

      const resultado = await registrarAportacion(getRepository(), userId, codBus, opcion);
      if (!resultado.ok) {
        return resultado.motivo === "bus_desconocido"
          ? busDesconocido(codBus)
          : toResponse(
              unprocessable(
                `La opción no pertenece al catálogo. Opciones válidas: ${OPCIONES_APORTACION.map((o) => o.id).join(", ")}.`,
              ),
            );
      }
      return NextResponse.json(
        { aportacion: aportacionPublica(resultado.aportacion) },
        { status: 201 },
      );
    },
    datos,
  );
}
