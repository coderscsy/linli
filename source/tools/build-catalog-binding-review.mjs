import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const [, , catalogArgument, musicArgument, groupArgument, outputArgument, ...recognitionArguments] = process.argv;
if (!catalogArgument || !musicArgument || !groupArgument || !outputArgument) {
  console.error("Usage: node build-catalog-binding-review.mjs <catalog-root> <music-root> <group> <output.json> [recognition.jsonl ...]");
  process.exitCode = 2;
} else {
  const catalogRoot = resolve(catalogArgument);
  const musicRoot = resolve(musicArgument);
  const group = String(groupArgument).normalize("NFKC");
  const outputPath = resolve(outputArgument);
  const invalidMarkers = /失效|无效|已使用|已兑换/u;
  const catalog = (await readFile(join(catalogRoot, `${group}.txt`), "utf8"))
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line && !invalidMarkers.test(line))
    .map(line => {
      const match = /^([A-Z0-9]+)\s*[—–-]+\s*(.+)$/iu.exec(line);
      return match ? { code: match[1].toUpperCase(), title: match[2].trim() } : null;
    })
    .filter(Boolean);
  const bindingFile = JSON.parse(await readFile(join(catalogRoot, "catalog-bindings.json"), "utf8"));
  const bindings = bindingFile?.groups?.[group] ?? {};

  const directories = [];
  const collect = async (root, depth = 0) => {
    if (depth > 6) return;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = join(root, entry.name);
      if (/^midi_[^\\/]+$/iu.test(entry.name)) directories.push(entry.name);
      else await collect(path, depth + 1);
    }
  };
  await collect(join(musicRoot, group));

  const recognitionByDirectory = new Map();
  for (const argument of recognitionArguments) {
    const content = await readFile(resolve(argument), "utf8");
    for (const line of content.split(/\r?\n/u).filter(Boolean)) {
      const item = JSON.parse(line);
      const directory = basename(String(item.sample ?? ""), ".wav");
      if (!directory) continue;
      const evidence = recognitionByDirectory.get(directory) ?? [];
      const title = String(item.decodedTitle ?? item.title ?? "").replaceAll("+", " ").trim();
      const key = `${title}\u0000${item.artist ?? ""}`;
      if (item.matched && title && !evidence.some(candidate => candidate.key === key)) {
        evidence.push({ key, title, artist: item.artist ?? null, shazamKey: item.shazamKey ?? null });
      }
      recognitionByDirectory.set(directory, evidence);
    }
  }

  const catalogByCode = new Map(catalog.map(item => [item.code, item]));
  const boundDirectories = new Set();
  const verified = [];
  for (const [code, directory] of Object.entries(bindings)) {
    const song = catalogByCode.get(code.toUpperCase());
    if (!song) continue;
    boundDirectories.add(directory);
    verified.push({ ...song, directory, recognition: recognitionByDirectory.get(directory) ?? [] });
  }
  verified.sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
  const unboundCatalog = catalog.filter(song => !(song.code in bindings));
  const unboundDirectories = directories
    .filter(directory => !boundDirectories.has(directory))
    .sort((left, right) => left.localeCompare(right, "en"))
    .map(directory => ({ directory, recognition: recognitionByDirectory.get(directory) ?? [] }));
  const review = {
    version: 1,
    generatedAt: new Date().toISOString(),
    group,
    counts: {
      validCatalog: catalog.length,
      directories: directories.length,
      verified: verified.length,
      unboundCatalog: unboundCatalog.length,
      unboundDirectories: unboundDirectories.length,
    },
    verified,
    unboundCatalog,
    unboundDirectories,
  };
  await writeFile(outputPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, ...review.counts }, null, 2));
}
