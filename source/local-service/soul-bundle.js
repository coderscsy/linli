import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

export const SOUL_MAGIC = Buffer.from("SOUL0001", "ascii");
export const MAX_SOUL_BYTES = 10 * 1024 * 1024 * 1024;
export const MAX_SOUL_MANIFEST_BYTES = 16 * 1024 * 1024;

export async function prepareSoulBundle(memory, videoFiles) {
  const files = [];
  for (const file of videoFiles) {
    const size = (await stat(file.filePath)).size;
    files.push({ ...file, size });
  }
  const manifest = Buffer.from(JSON.stringify({
    schema: "olivia-soul.bundle",
    version: 2,
    memory,
    videos: files.map(({ letterId, contentMd5, size }) => ({ letterId, contentMd5, size })),
  }), "utf8");
  if (manifest.length > MAX_SOUL_MANIFEST_BYTES) throw new Error("信件清单过大");
  const header = Buffer.alloc(16);
  SOUL_MAGIC.copy(header);
  header.writeBigUInt64LE(BigInt(manifest.length), 8);
  const totalSize = header.length + manifest.length + files.reduce((total, file) => total + file.size, 0);
  if (totalSize > MAX_SOUL_BYTES) throw new Error(".soul 文件不能超过 10 GB");
  return { header, manifest, files, totalSize };
}

export async function writeSoulBundle(path, memory, videoFiles) {
  const bundle = await prepareSoulBundle(memory, videoFiles);
  const output = await open(path, "wx");
  try {
    await output.writeFile(bundle.header);
    await output.writeFile(bundle.manifest);
    for (const file of bundle.files)
      for await (const chunk of createReadStream(file.filePath))
        await output.writeFile(chunk);
  } finally {
    await output.close();
  }
  return bundle.totalSize;
}
