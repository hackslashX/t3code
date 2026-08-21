import { KubeConfig } from "@kubernetes/client-node";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class KubernetesConfigError extends Schema.TaggedErrorClass<KubernetesConfigError>()(
  "KubernetesConfigError",
  {
    reason: Schema.Literals(["kubernetes_config_load_failed"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class KubernetesConfig extends Context.Service<KubernetesConfig, KubeConfig>()(
  "@t3tools/control-plane/KubernetesConfig",
) {}

const kubeconfigFile = Config.string("T3CODE_KUBERNETES_KUBECONFIG_FILE").pipe(Config.option);

export const make = Effect.gen(function* () {
  const file = yield* kubeconfigFile;
  return yield* Effect.try({
    try: () => {
      const config = new KubeConfig();
      if (Option.isSome(file)) config.loadFromFile(file.value);
      else config.loadFromCluster();
      return KubernetesConfig.of(config);
    },
    catch: (cause) => new KubernetesConfigError({ reason: "kubernetes_config_load_failed", cause }),
  });
});

export const layer = Layer.effect(KubernetesConfig, make);
