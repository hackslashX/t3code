import { WorkspaceId, WorkspaceVolumeId } from "@t3tools/hosted-contracts";
import * as Schema from "effect/Schema";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const WorkspaceDeletionTarget = Schema.Struct({
  workspaceId: WorkspaceId,
  resourceName: Schema.String,
  volumeId: WorkspaceVolumeId,
  pvcName: Schema.String,
  pvcUid: Schema.optionalKey(Schema.String),
  volumeSource: Schema.Literals(["created", "imported"]),
  volumePolicy: Schema.Literals(["retain", "delete"]),
  generation: NonNegativeInt,
});
export type WorkspaceDeletionTarget = typeof WorkspaceDeletionTarget.Type;
