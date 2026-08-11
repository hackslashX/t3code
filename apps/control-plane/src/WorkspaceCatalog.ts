import { StorageClassOption } from "@t3tools/hosted-contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const WorkspaceCatalogDocument = Schema.Struct({
  imageProfiles: Schema.Array(Schema.String),
  egressProfiles: Schema.Array(Schema.String),
  nodes: Schema.Array(Schema.String),
  storageClasses: Schema.Array(StorageClassOption),
  gpuClasses: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        maximumPerWorkspace: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      }),
    ),
  ),
});

export class WorkspaceCatalogError extends Schema.TaggedErrorClass<WorkspaceCatalogError>()(
  "WorkspaceCatalogError",
  {
    reason: Schema.Literals(["catalog_read_failed", "catalog_invalid"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface WorkspaceCatalogValue {
  readonly imageProfiles: ReadonlySet<string>;
  readonly egressProfiles: ReadonlySet<string>;
  readonly nodes: ReadonlySet<string>;
  readonly storageClasses: ReadonlyMap<string, StorageClassOption>;
  readonly gpuClassMaximums: ReadonlyMap<string, number>;
}

export class WorkspaceCatalog extends Context.Service<WorkspaceCatalog, WorkspaceCatalogValue>()(
  "@t3tools/control-plane/WorkspaceCatalog",
) {}

const catalogFile = Config.string("T3CODE_CONTROL_PLANE_WORKSPACE_CATALOG_FILE");

export const decodeWorkspaceCatalog = Effect.fn("WorkspaceCatalog.decode")(function* (
  contents: string,
) {
  const document = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(WorkspaceCatalogDocument),
  )(contents).pipe(
    Effect.mapError((cause) => new WorkspaceCatalogError({ reason: "catalog_invalid", cause })),
  );
  if (
    document.imageProfiles.length === 0 ||
    document.egressProfiles.length === 0 ||
    document.nodes.length === 0 ||
    new Set(document.nodes).size !== document.nodes.length
  ) {
    return yield* new WorkspaceCatalogError({ reason: "catalog_invalid" });
  }
  const storageClasses = new Map(document.storageClasses.map((item) => [item.name, item]));
  if (storageClasses.size !== document.storageClasses.length) {
    return yield* new WorkspaceCatalogError({ reason: "catalog_invalid" });
  }
  return {
    imageProfiles: new Set(document.imageProfiles),
    egressProfiles: new Set(document.egressProfiles),
    nodes: new Set(document.nodes),
    storageClasses,
    gpuClassMaximums: new Map(
      (document.gpuClasses ?? []).map((item) => [item.name, item.maximumPerWorkspace]),
    ),
  } satisfies WorkspaceCatalogValue;
});

export const make = Effect.gen(function* () {
  const path = yield* catalogFile;
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(path)
    .pipe(
      Effect.mapError(
        (cause) => new WorkspaceCatalogError({ reason: "catalog_read_failed", cause }),
      ),
    );
  return WorkspaceCatalog.of(yield* decodeWorkspaceCatalog(contents));
});

export const layer = Layer.effect(WorkspaceCatalog, make);
