import { dirname, isAbsolute, relative, resolve, win32 } from "node:path";

export function assertContained(parent, child) {
  const root = resolve(parent);
  const target = resolve(child);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${win32.sep}`) || isAbsolute(rel)) {
    throw new Error(`路径越过根目录: ${target}`);
  }
  return target;
}

export function resolveProbeLayout(dataRoot, { requiredDrive = "I:" } = {}) {
  const root = win32.resolve(dataRoot);
  if (win32.parse(root).root.slice(0, 2).toUpperCase() !== requiredDrive.toUpperCase()) {
    throw new Error(`运行数据根目录必须位于 ${requiredDrive.slice(0, 1)} 盘: ${root}`);
  }
  const evidenceDir = assertContained(root, win32.join(root, "evidence"));
  return Object.freeze({
    root,
    evidenceDir,
    reportJson: assertContained(root, win32.join(evidenceDir, "stage1a-report.json")),
    reportMarkdown: assertContained(root, win32.join(evidenceDir, "stage1a-report.md")),
    binaryEvidenceJson: assertContained(root, win32.join(evidenceDir, "binary-protocol-evidence.json")),
  });
}
