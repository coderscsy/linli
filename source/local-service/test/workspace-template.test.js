import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareWorkspaceIncrementally } from "../desktop/workspace-template.js";

test("工作区模板未变化时跳过复制且始终保留用户信件", async t => {
  const base = await mkdtemp(join(tmpdir(), "olivia-workspace-template-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const template = join(base, "template");
  const root = join(base, "UserData");
  const settings = join(root, "settings");
  await mkdir(join(template, ".cursor", "skills"), { recursive: true });
  await mkdir(join(template, "harness"), { recursive: true });
  await writeFile(join(template, ".cursor", "skills", "skill.txt"), "v1");
  await writeFile(join(template, "harness", "VERSION"), "v1");
  await mkdir(join(root, "信件往来"), { recursive: true });
  await writeFile(join(root, "信件往来", "用户.md"), "不要覆盖");

  const first = await prepareWorkspaceIncrementally({ template, root, settings });
  assert.equal(first.changed, true);
  assert.equal(await readFile(join(root, ".cursor", "skills", "skill.txt"), "utf8"), "v1");

  await writeFile(join(root, ".cursor", "skills", "skill.txt"), "本地保留");
  const second = await prepareWorkspaceIncrementally({ template, root, settings });
  assert.equal(second.changed, false);
  assert.equal(await readFile(join(root, ".cursor", "skills", "skill.txt"), "utf8"), "本地保留");

  await writeFile(join(template, ".cursor", "skills", "skill.txt"), "v2");
  const third = await prepareWorkspaceIncrementally({ template, root, settings });
  assert.equal(third.changed, true);
  assert.equal(await readFile(join(root, ".cursor", "skills", "skill.txt"), "utf8"), "v2");
  assert.equal(await readFile(join(root, "信件往来", "用户.md"), "utf8"), "不要覆盖");
  assert.match(await readFile(join(settings, "workspace-template.sha256"), "utf8"), /^[a-f0-9]{64}\n$/u);
});
