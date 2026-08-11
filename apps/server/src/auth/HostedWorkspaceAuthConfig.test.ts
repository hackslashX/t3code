import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { loadPublicKeys } from "./HostedWorkspaceAuthConfig.ts";

it.layer(NodeServices.layer)("HostedWorkspaceAuthConfig.loadPublicKeys", (it) => {
  it.effect("loads PEM files by filename key ID", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-hosted-public-keys-",
      });
      const keyPair = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      yield* fileSystem.writeFileString(
        path.join(directory, "key-2026.pem"),
        keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      );
      yield* fileSystem.writeFileString(path.join(directory, "README.txt"), "ignored");

      const keys = yield* loadPublicKeys(directory);
      assert.deepEqual([...keys.keys()], ["key-2026"]);
      assert.equal(keys.get("key-2026")?.type, "public");
    }),
  );

  it.effect("rejects an empty key directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-hosted-public-keys-empty-",
      });
      const exit = yield* Effect.exit(loadPublicKeys(directory));
      assert(exit._tag === "Failure");
    }),
  );

  it.effect("rejects invalid PEM", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-hosted-public-keys-invalid-",
      });
      yield* fileSystem.writeFileString(path.join(directory, "broken.pem"), "not a key");
      const exit = yield* Effect.exit(loadPublicKeys(directory));
      assert(exit._tag === "Failure");
    }),
  );
});
