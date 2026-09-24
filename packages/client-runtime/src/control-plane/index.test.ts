import { assert, describe, it } from "@effect/vitest";
import { OrganizationId, WorkspaceId } from "@t3tools/hosted-contracts";

import { HostedControlPlaneError, makeHostedControlPlaneClient } from "./index.ts";

const organizationId = OrganizationId.make("00000000-0000-4000-8000-000000000010");
const workspaceId = WorkspaceId.make("00000000-0000-4000-8000-000000000020");

describe("HostedControlPlaneClient", () => {
  it("uses credentialed requests and decodes desired-state receipts", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const client = makeHostedControlPlaneClient({
      baseUrl: "https://control.example.test/",
      fetch: async (input, init) => {
        requests.push({ input: String(input), ...(init === undefined ? {} : { init }) });
        return new Response(
          JSON.stringify({ workspaceId, desiredState: "Stopped", generation: 3, changed: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const result = await client.setDesiredState(organizationId, workspaceId, {
      desiredState: "Stopped",
      expectedGeneration: 2,
    });
    assert.equal(result.generation, 3);
    assert.equal(
      requests[0]?.input,
      `https://control.example.test/api/organizations/${organizationId}/workspaces/${workspaceId}/desired-state`,
    );
    assert.equal(requests[0]?.init?.method, "POST");
    assert.equal(requests[0]?.init?.credentials, "include");
  });

  it("preserves sanitized API error codes", async () => {
    const client = makeHostedControlPlaneClient({
      fetch: async () =>
        new Response(JSON.stringify({ error: "workspace_not_ready" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    });
    try {
      await client.createProxySession(organizationId, workspaceId);
      assert.fail("expected request rejection");
    } catch (error) {
      assert.isTrue(error instanceof HostedControlPlaneError);
      assert.equal((error as HostedControlPlaneError).status, 409);
      assert.equal((error as HostedControlPlaneError).code, "workspace_not_ready");
    }
  });
});
