import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Database from "./Database.ts";
import { runMigrations } from "./Migrations.ts";

const RuntimeLayer = Database.layer.pipe(Layer.provideMerge(NodeServices.layer));

if (import.meta.main) {
  runMigrations().pipe(
    Effect.tap(() => Effect.logInfo("Control-plane database migrations are current.")),
    Effect.provide(RuntimeLayer),
    Effect.scoped,
    NodeRuntime.runMain,
  );
}
