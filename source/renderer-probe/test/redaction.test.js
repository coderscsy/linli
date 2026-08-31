import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/redaction.js";

test("redacts token fields and JWT-looking strings recursively", () => {
  const value = redactSecrets({
    headers: { "x-token": "toy_secret", authorization: "Bearer secret" },
    nested: ["aaa.bbb.ccc", "ovilia_Win64_Development_15918"],
  });
  assert.deepEqual(value, {
    headers: { "x-token": "[REDACTED]", authorization: "[REDACTED]" },
    nested: ["[REDACTED]", "ovilia_Win64_Development_15918"],
  });
});
