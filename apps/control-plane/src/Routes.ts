import * as Layer from "effect/Layer";

import * as ApiRoutes from "./ApiRoutes.ts";
import * as AuthRoutes from "./AuthRoutes.ts";
import * as HealthRoutes from "./HealthRoutes.ts";
import * as OrganizationRoutes from "./OrganizationRoutes.ts";
import * as StorageRoutes from "./StorageRoutes.ts";
import * as WorkspaceRoutes from "./WorkspaceRoutes.ts";

export const layer = Layer.mergeAll(
  AuthRoutes.layer,
  HealthRoutes.layer,
  ApiRoutes.layer,
  OrganizationRoutes.layer,
  StorageRoutes.layer,
  WorkspaceRoutes.layer,
);
