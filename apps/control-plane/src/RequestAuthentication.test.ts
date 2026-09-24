import { assert, it } from "@effect/vitest";

import { isAllowedMutationOrigin } from "./RequestAuthentication.ts";

it("requires an exact Origin match for cookie-authenticated mutations", () => {
  assert.isTrue(
    isAllowedMutationOrigin("https://hosted.example.com", "https://hosted.example.com"),
  );
  assert.isFalse(isAllowedMutationOrigin(undefined, "https://hosted.example.com"));
  assert.isFalse(
    isAllowedMutationOrigin("https://hosted.example.com.evil.test", "https://hosted.example.com"),
  );
  assert.isFalse(
    isAllowedMutationOrigin("https://hosted.example.com:444", "https://hosted.example.com"),
  );
});
