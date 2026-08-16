import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

const liveRoute = HttpRouter.add(
  "GET",
  "/healthz",
  HttpServerResponse.jsonUnsafe({ status: "ok" }),
);

const readyRoute = HttpRouter.add(
  "GET",
  "/readyz",
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`SELECT 1`;
    return HttpServerResponse.jsonUnsafe({ status: "ready" });
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ status: "unavailable" }, { status: 503 })),
    ),
  ),
);

export const layer = Layer.merge(liveRoute, readyRoute);
