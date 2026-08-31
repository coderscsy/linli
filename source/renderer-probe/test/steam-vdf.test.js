import assert from "node:assert/strict";
import test from "node:test";

import { parseAppManifest } from "../src/steam-vdf.js";

const manifest = `"AppState"\n{\n"appid" "4532590"\n"name" "BSide: Olivia Lin"\n"installdir" "BSide Olivia Lin Test"\n"buildid" "24943426"\n"InstalledDepots"\n{\n"4532591"\n{\n"manifest" "3483511100282414030"\n"size" "3690442569"\n}\n}\n}`;

test("parses the installed Olivia app and depot identity", () => {
  const result = parseAppManifest(manifest);

  assert.deepEqual(result.depots, [{ depotId: "4532591", manifestId: "3483511100282414030", size: 3690442569 }]);
  assert.equal(result.appId, "4532590");
  assert.equal(result.name, "BSide: Olivia Lin");
  assert.equal(result.installDir, "BSide Olivia Lin Test");
  assert.equal(result.buildId, "24943426");
});

test("rejects manifests without AppState instead of guessing", () => {
  assert.throws(() => parseAppManifest(`"Other" { "appid" "4532590" }`), /缺少 AppState/u);
});

test("rejects duplicate scalar keys", () => {
  assert.throws(
    () => parseAppManifest(`"AppState" { "appid" "4532590" "appid" "999" }`),
    /重复/u,
  );
});
