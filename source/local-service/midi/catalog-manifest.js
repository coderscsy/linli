import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";

const VIDEO_EXTENSIONS = new Set([".mp4"]);
const INVALID_CATALOG_MARKERS = /失效|无效|已使用|已兑换/u;

function toPortablePath(value) {
  return value.split(sep).join("/");
}

async function collectPerformanceDirectories(root, output, depth = 0) {
  if (depth > 6) return;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (/^midi_[^\\/]+$/iu.test(entry.name)) {
      output.push(path);
      continue;
    }
    await collectPerformanceDirectories(path, output, depth + 1);
  }
}

function parseCatalogLine(line) {
  const value = line.trim();
  if (!value || INVALID_CATALOG_MARKERS.test(value)) return null;
  const codeMatch = /^([A-Z0-9]+)/iu.exec(value);
  if (!codeMatch) return { code: "未编号", title: value };
  const code = codeMatch[1].toUpperCase();
  const title = value.slice(codeMatch[0].length).replace(/^[\s—–-]+/u, "").trim();
  return { code, title: title || value };
}

async function readCatalog(catalogRoot, group) {
  try {
    const content = await readFile(join(catalogRoot, `${group}.txt`), "utf8");
    return content.replace(/^\uFEFF/u, "").split(/\r?\n/u).map(parseCatalogLine).filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readCatalogBindings(catalogRoot) {
  try {
    const parsed = JSON.parse(await readFile(join(catalogRoot, "catalog-bindings.json"), "utf8"));
    return parsed?.groups && typeof parsed.groups === "object" ? parsed.groups : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function uniqueName(baseName, jobDirectory, usedNames) {
  let name = baseName;
  if (usedNames.has(name)) name = `${baseName}【${basename(jobDirectory)}】`;
  let suffix = 2;
  while (usedNames.has(name)) name = `${baseName}【${basename(jobDirectory)} · ${suffix++}】`;
  usedNames.add(name);
  return name;
}

export async function buildPlayerUploadManifest({ musicRoot, catalogRoot }) {
  const groups = (await readdir(musicRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  const songs = [];
  const warnings = [];
  const usedNames = new Set();
  let namedCount = 0;
  let fallbackCount = 0;
  let videoCount = 0;
  const bindings = await readCatalogBindings(catalogRoot);

  for (const groupEntry of groups) {
    const group = groupEntry.name;
    const performanceDirectories = [];
    await collectPerformanceDirectories(join(musicRoot, group), performanceDirectories);
    const catalog = await readCatalog(catalogRoot, group);
    const catalogByCode = new Map(catalog.map(entry => [entry.code, entry]));
    const catalogByDirectory = new Map();
    const groupBindings = bindings[group] && typeof bindings[group] === "object" ? bindings[group] : {};
    for (const [rawCode, rawDirectory] of Object.entries(groupBindings)) {
      const code = String(rawCode).trim().toUpperCase();
      const directory = basename(String(rawDirectory).trim());
      const catalogEntry = catalogByCode.get(code);
      if (!catalogEntry) {
        warnings.push(`${group}：绑定中的分享码 ${code} 不在曲目目录中`);
        continue;
      }
      if (catalogByDirectory.has(directory)) {
        warnings.push(`${group}：演奏目录 ${directory} 被重复绑定，已忽略后一个绑定`);
        continue;
      }
      catalogByDirectory.set(directory, catalogEntry);
    }
    if (catalog.length !== performanceDirectories.length) {
      warnings.push(`${group}：有效目录条目 ${catalog.length} 条，演奏目录 ${performanceDirectories.length} 个`);
    }
    const verifiedCodes = new Set([...catalogByDirectory.values()].map(entry => entry.code));
    const unverifiedCount = catalog.filter(entry => !verifiedCodes.has(entry.code)).length;
    if (unverifiedCount) warnings.push(`${group}：${unverifiedCount} 条曲目尚未建立已验证的目录绑定`);

    for (let index = 0; index < performanceDirectories.length; index += 1) {
      const jobDirectory = performanceDirectories[index];
      const videos = (await readdir(jobDirectory, { withFileTypes: true }))
        .filter(entry => entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
        .map(entry => join(jobDirectory, entry.name))
        .sort((left, right) => left.localeCompare(right, "en"));
      if (!videos.length) {
        warnings.push(`${group}：${basename(jobDirectory)} 没有 MP4，已跳过`);
        continue;
      }

      const catalogEntry = catalogByDirectory.get(basename(jobDirectory));
      const baseName = catalogEntry
        ? `${catalogEntry.title}【${group} · ${catalogEntry.code}】`
        : `${group} · ${basename(jobDirectory)}`;
      if (catalogEntry) namedCount += 1;
      else fallbackCount += 1;
      const variants = Object.fromEntries(videos.map((video, videoIndex) => [
        videoIndex === 0 ? "DEFAULT" : `ALT_${videoIndex + 1}`,
        toPortablePath(relative(musicRoot, video)),
      ]));
      songs.push({
        name: uniqueName(baseName, jobDirectory, usedNames),
        variants,
      });
      videoCount += videos.length;
    }
  }

  return {
    songs,
    performanceCount: songs.length,
    videoCount,
    namedCount,
    fallbackCount,
    warnings,
  };
}
