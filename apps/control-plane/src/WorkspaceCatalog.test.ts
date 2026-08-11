import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decodeWorkspaceCatalog } from "./WorkspaceCatalog.ts";

it.effect("decodes the mounted workspace catalog", () =>
  Effect.gen(function* () {
    const catalog = yield* decodeWorkspaceCatalog(`{
      "imageProfiles": ["stable"],
      "egressProfiles": ["restricted"],
      "nodes": ["orion", "atlas"],
      "storageClasses": [{
        "name": "longhorn-ssd-orion",
        "isDefault": true,
        "allowExpansion": true,
        "bindingMode": "Immediate",
        "allowedAccessModes": ["ReadWriteOnce"],
        "minimumBytes": 1073741824,
        "maximumBytes": 1099511627776
      }],
      "gpuClasses": []
    }`);
    assert.isTrue(catalog.imageProfiles.has("stable"));
    assert.equal(catalog.storageClasses.get("longhorn-ssd-orion")?.bindingMode, "Immediate");
  }),
);

it.effect("rejects empty profile sets", () =>
  Effect.gen(function* () {
    const duplicate = `{
      "imageProfiles": [],
      "egressProfiles": ["restricted"],
      "nodes": ["orion", "atlas"],
      "storageClasses": [],
      "gpuClasses": []
    }`;
    assert.equal((yield* Effect.exit(decodeWorkspaceCatalog(duplicate)))._tag, "Failure");
  }),
);
