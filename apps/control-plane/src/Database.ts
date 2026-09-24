import * as PgClient from "@effect/sql-pg/PgClient";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class ControlPlaneDatabaseConfigError extends Schema.TaggedErrorClass<ControlPlaneDatabaseConfigError>()(
  "ControlPlaneDatabaseConfigError",
  {
    reason: Schema.Literals(["database_url_read_failed", "database_url_empty"]),
    path: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const databaseUrlFile = Config.string("T3CODE_CONTROL_PLANE_DATABASE_URL_FILE");

export const readDatabaseUrl = Effect.fn("ControlPlaneDatabase.readUrl")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const value = yield* fileSystem.readFileString(path).pipe(
    Effect.mapError(
      (cause) =>
        new ControlPlaneDatabaseConfigError({
          reason: "database_url_read_failed",
          path,
          cause,
        }),
    ),
  );
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return yield* new ControlPlaneDatabaseConfigError({
      reason: "database_url_empty",
      path,
    });
  }
  return Redacted.make(trimmed);
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const path = yield* databaseUrlFile;
    const url = yield* readDatabaseUrl(path);
    return PgClient.layer({
      url,
      applicationName: "t3-hosted-control-plane",
      maxConnections: 10,
      minConnections: 1,
      connectTimeout: "10 seconds",
      idleTimeout: "30 seconds",
    });
  }),
);
