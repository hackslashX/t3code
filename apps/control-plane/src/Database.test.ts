import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

import { readDatabaseUrl } from "./Database.ts";

it.layer(NodeServices.layer)("ControlPlaneDatabase", (it) => {
  it.effect("reads and trims the database URL from a secret file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-control-plane-database-",
      });
      const secretPath = path.join(directory, "url");
      yield* fileSystem.writeFileString(
        secretPath,
        "  postgresql://user:secret@postgres.example.test/t3  \n",
      );
      const url = yield* readDatabaseUrl(secretPath);
      assert.equal(Redacted.value(url), "postgresql://user:secret@postgres.example.test/t3");
    }),
  );

  it.effect("rejects an empty database URL secret", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-control-plane-database-empty-",
      });
      const secretPath = path.join(directory, "url");
      yield* fileSystem.writeFileString(secretPath, " \n");
      const exit = yield* Effect.exit(readDatabaseUrl(secretPath));
      assert(exit._tag === "Failure");
    }),
  );
});
