import * as PgClient from "@effect/sql-pg/PgClient";
import * as NodeCrypto from "node:crypto";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class ControlPlaneMigrationError extends Schema.TaggedErrorClass<ControlPlaneMigrationError>()(
  "ControlPlaneMigrationError",
  {
    reason: Schema.Literals([
      "migration_directory_read_failed",
      "migration_file_read_failed",
      "migration_checksum_mismatch",
      "migration_apply_failed",
    ]),
    migration: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const defaultMigrationsDirectory = new URL("../migrations", import.meta.url).pathname;
const migrationsDirectory = Config.string("T3CODE_CONTROL_PLANE_MIGRATIONS_DIR").pipe(
  Config.withDefault(defaultMigrationsDirectory),
);

const checksum = (contents: string) =>
  NodeCrypto.createHash("sha256").update(contents).digest("hex");

export const runMigrations = Effect.fn("ControlPlaneMigrations.run")(function* () {
  const directory = yield* migrationsDirectory;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* PgClient.PgClient;
  const entries = yield* fileSystem.readDirectory(directory).pipe(
    Effect.mapError(
      (cause) =>
        new ControlPlaneMigrationError({
          reason: "migration_directory_read_failed",
          cause,
        }),
    ),
  );
  const migrations = entries.filter((entry) => /^\d+_[a-z0-9_]+\.sql$/.test(entry)).toSorted();

  yield* sql
    .unsafe(`
    CREATE TABLE IF NOT EXISTS control_plane_schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
    .pipe(
      Effect.mapError(
        (cause) => new ControlPlaneMigrationError({ reason: "migration_apply_failed", cause }),
      ),
    );

  for (const migration of migrations) {
    const migrationPath = path.join(directory, migration);
    const contents = yield* fileSystem.readFileString(migrationPath).pipe(
      Effect.mapError(
        (cause) =>
          new ControlPlaneMigrationError({
            reason: "migration_file_read_failed",
            migration,
            cause,
          }),
      ),
    );
    const expectedChecksum = checksum(contents);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT pg_advisory_xact_lock(hashtext('t3-hosted-control-plane-migrations'))`;
          const applied = yield* sql<{ readonly checksum: string }>`
          SELECT checksum
          FROM control_plane_schema_migrations
          WHERE name = ${migration}
        `;
          if (applied.length > 0) {
            if (applied[0]?.checksum !== expectedChecksum) {
              return yield* new ControlPlaneMigrationError({
                reason: "migration_checksum_mismatch",
                migration,
              });
            }
            return;
          }
          yield* sql.unsafe(contents);
          yield* sql`
          INSERT INTO control_plane_schema_migrations (name, checksum)
          VALUES (${migration}, ${expectedChecksum})
        `;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(ControlPlaneMigrationError)(cause)
            ? cause
            : new ControlPlaneMigrationError({
                reason: "migration_apply_failed",
                migration,
                cause,
              }),
        ),
      );
  }
});
