import { rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { buildPlayerUploadManifest } from "../local-service/midi/catalog-manifest.js";

const [, , musicArgument, catalogArgument, outputArgument] = process.argv;
if (!musicArgument || !catalogArgument) {
  console.error("Usage: node build-player-upload-manifest.mjs <music-root> <catalog-root> [output-json]");
  process.exitCode = 2;
} else {
  const musicRoot = resolve(musicArgument);
  const catalogRoot = resolve(catalogArgument);
  const outputPath = resolve(outputArgument || join(musicRoot, "library.json"));
  const temporaryPath = `${outputPath}.partial`;
  const manifest = await buildPlayerUploadManifest({ musicRoot, catalogRoot });
  const payload = {
    ...manifest,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temporaryPath, outputPath);
  console.log(JSON.stringify({ outputPath, ...manifest, songs: undefined }, null, 2));
}
