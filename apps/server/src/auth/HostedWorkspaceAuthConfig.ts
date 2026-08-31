import * as NodeCrypto from "node:crypto";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export type HostedWorkspaceAuthConfigValue =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly issuer: string;
      readonly workspaceId: string;
      readonly publicKeys: ReadonlyMap<string, NodeCrypto.KeyObject>;
      readonly sessionLifetimeSeconds: number;
    };

export class HostedWorkspaceAuthConfigError extends Schema.TaggedErrorClass<HostedWorkspaceAuthConfigError>()(
  "HostedWorkspaceAuthConfigError",
  {
    reason: Schema.Literals([
      "partial_configuration",
      "public_keys_read_failed",
      "public_key_invalid",
      "public_keys_empty",
    ]),
    path: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export const HostedWorkspaceAuthConfig = Context.Reference<HostedWorkspaceAuthConfigValue>(
  "t3/auth/HostedWorkspaceAuthConfig",
  { defaultValue: () => ({ enabled: false }) },
);

const envConfig = Config.all({
  issuer: Config.string("T3CODE_HOSTED_WORKSPACE_ISSUER").pipe(Config.option),
  workspaceId: Config.string("T3CODE_HOSTED_WORKSPACE_ID").pipe(Config.option),
  publicKeysDir: Config.string("T3CODE_HOSTED_WORKSPACE_PUBLIC_KEYS_DIR").pipe(Config.option),
  sessionLifetimeSeconds: Config.int("T3CODE_HOSTED_WORKSPACE_SESSION_LIFETIME_SECONDS").pipe(
    Config.withDefault(300),
  ),
});

export const loadPublicKeys = Effect.fn("HostedWorkspaceAuthConfig.loadPublicKeys")(function* (
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem.readDirectory(directory).pipe(
    Effect.mapError(
      (cause) =>
        new HostedWorkspaceAuthConfigError({
          reason: "public_keys_read_failed",
          path: directory,
          cause,
        }),
    ),
  );
  const keyFiles = entries.filter((entry) => entry.endsWith(".pem")).toSorted();
  if (keyFiles.length === 0) {
    return yield* new HostedWorkspaceAuthConfigError({
      reason: "public_keys_empty",
      path: directory,
    });
  }

  const keys = new Map<string, NodeCrypto.KeyObject>();
  for (const entry of keyFiles) {
    const keyPath = path.join(directory, entry);
    const pem = yield* fileSystem.readFileString(keyPath).pipe(
      Effect.mapError(
        (cause) =>
          new HostedWorkspaceAuthConfigError({
            reason: "public_keys_read_failed",
            path: keyPath,
            cause,
          }),
      ),
    );
    const publicKey = yield* Effect.try({
      try: () => NodeCrypto.createPublicKey(pem),
      catch: (cause) =>
        new HostedWorkspaceAuthConfigError({
          reason: "public_key_invalid",
          path: keyPath,
          cause,
        }),
    });
    keys.set(entry.slice(0, -4), publicKey);
  }
  return keys as ReadonlyMap<string, NodeCrypto.KeyObject>;
});

export const make = Effect.gen(function* () {
  const values = yield* envConfig;
  const configured = [values.issuer, values.workspaceId, values.publicKeysDir].filter(
    Option.isSome,
  );
  if (configured.length === 0) {
    return { enabled: false } satisfies HostedWorkspaceAuthConfigValue;
  }
  if (configured.length !== 3) {
    return yield* new HostedWorkspaceAuthConfigError({ reason: "partial_configuration" });
  }

  const issuer = Option.getOrThrow(values.issuer).trim();
  const workspaceId = Option.getOrThrow(values.workspaceId).trim();
  const publicKeysDir = Option.getOrThrow(values.publicKeysDir).trim();
  if (
    issuer.length === 0 ||
    workspaceId.length === 0 ||
    publicKeysDir.length === 0 ||
    values.sessionLifetimeSeconds < 60 ||
    values.sessionLifetimeSeconds > 86_400
  ) {
    return yield* new HostedWorkspaceAuthConfigError({ reason: "partial_configuration" });
  }
  const publicKeys = yield* loadPublicKeys(publicKeysDir);
  return {
    enabled: true,
    issuer,
    workspaceId,
    publicKeys,
    sessionLifetimeSeconds: values.sessionLifetimeSeconds,
  } satisfies HostedWorkspaceAuthConfigValue;
});

export const layer = Layer.effect(HostedWorkspaceAuthConfig, make);
export const layerDisabled = Layer.succeed(HostedWorkspaceAuthConfig, {
  enabled: false,
} satisfies HostedWorkspaceAuthConfigValue);
