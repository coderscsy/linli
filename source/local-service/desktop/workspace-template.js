import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const TEMPLATE_ENTRIES = [
  [".cursor", "skills"],
  ["harness"],
  ["tools"],
  ["林离人设.md"],
];

async function filesBelow(path) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (info.isFile()) return [path];
  if (!info.isDirectory()) return [];
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => filesBelow(join(path, entry.name))));
  return nested.flat();
}

async function templateDigest(template) {
  const hash = createHash("sha256");
  const files = (await Promise.all(TEMPLATE_ENTRIES.map(parts => filesBelow(join(template, ...parts)))))
    .flat()
    .sort((left, right) => relative(template, left).localeCompare(relative(template, right)));
  for (const path of files) {
    hash.update(relative(template, path).replaceAll("\\", "/"), "utf8");
    hash.update("\0");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function copyIfPresent(source, destination) {
  try {
    await cp(source, destination, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function prepareWorkspaceIncrementally({ template, root, settings }) {
  const resolvedTemplate = resolve(template);
  const resolvedRoot = resolve(root);
  const resolvedSettings = resolve(settings);
  await Promise.all([
    mkdir(resolvedRoot, { recursive: true }),
    mkdir(resolvedSettings, { recursive: true }),
    mkdir(join(resolvedRoot, "信件往来"), { recursive: true }),
    mkdir(join(resolvedRoot, "信件往来_原始语料"), { recursive: true }),
  ]);
  const digest = await templateDigest(resolvedTemplate);
  const digestPath = join(resolvedSettings, "workspace-template.sha256");
  let current = "";
  try {
    current = (await readFile(digestPath, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (current === digest) return { changed: false, digest };

  await Promise.all(TEMPLATE_ENTRIES.map(parts => copyIfPresent(
    join(resolvedTemplate, ...parts),
    join(resolvedRoot, ...parts),
  )));
  await Promise.all([
    rm(join(resolvedRoot, ".cursor", "rules"), { recursive: true, force: true }),
    rm(join(resolvedRoot, "harness", "00-strict-precheck.md"), { force: true }),
    rm(join(resolvedRoot, "harness", "00-脚本算术.md"), { force: true }),
    rm(join(resolvedRoot, "harness", "02-读信感.md"), { force: true }),
    rm(join(resolvedRoot, "harness", "06-实时回信.md"), { force: true }),
  ]);
  const temporary = `${digestPath}.tmp-${process.pid}`;
  await mkdir(dirname(temporary), { recursive: true });
  await writeFile(temporary, `${digest}\n`, "utf8");
  await rename(temporary, digestPath);
  return { changed: true, digest };
}
