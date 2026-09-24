import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

export class OperatorConfigError extends Schema.TaggedErrorClass<OperatorConfigError>()(
  "OperatorConfigError",
  {
    reason: Schema.Literals(["egress_config_read_failed", "egress_config_invalid"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const environment = Config.all({
  namespace: Config.string("T3CODE_WORKSPACE_OPERATOR_NAMESPACE"),
  egressCidrsFile: Config.string("T3CODE_WORKSPACE_OPERATOR_EGRESS_CIDRS_FILE"),
});
const EgressCidrs = Schema.Record(Schema.String, Schema.Array(Schema.String));

export const loadOperatorConfig = Effect.gen(function* () {
  const config = yield* environment;
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(config.egressCidrsFile)
    .pipe(
      Effect.mapError(
        (cause) => new OperatorConfigError({ reason: "egress_config_read_failed", cause }),
      ),
    );
  const egressCidrsByProfile = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(EgressCidrs),
  )(contents).pipe(
    Effect.mapError((cause) => new OperatorConfigError({ reason: "egress_config_invalid", cause })),
  );
  return {
    namespace: config.namespace,
    renderer: {
      proxyPodLabels: { "app.kubernetes.io/component": "workspace-proxy" },
      dnsNamespaceLabels: { "kubernetes.io/metadata.name": "kube-system" },
      egressCidrsByProfile,
    },
  };
});
