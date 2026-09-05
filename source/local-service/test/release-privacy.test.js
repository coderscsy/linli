import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const repository = resolve(project, "../");
const task = resolve(project, "../../.superpowers/sdd/2026-09-05-release-privacy");
const safetyScript = join(project, "packaging/package-safety.ps1");
const modelScript = join(repository, ".cursor/skills/fit-letters/scripts/model-call.ps1");
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

async function fixture() {
  await mkdir(join(task, "fixtures"), { recursive: true });
  const root = await mkdtemp(join(task, "fixtures/privacy-"));
  return root;
}

async function put(root, name, content = "") {
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
}

async function putBytes(root, name, content) {
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

function powershell(command) {
  return spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command", command,
  ], { encoding: "utf8" });
}

function psArray(values) {
  return `@(${values.map(quote).join(",")})`;
}

function psHashtable(entries) {
  return `@{${Object.entries(entries).map(([name, hash]) => `${quote(name)}=${quote(hash)}`).join(";")}}`;
}

function runPrivacyGate(root, { forbiddenValues = [], trustedFiles = {} } = {}) {
  return powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; Assert-PublicPackageTree -Path ${quote(root)} -ForbiddenValues ${psArray(forbiddenValues)} -TrustedFiles ${psHashtable(trustedFiles)}`);
}

test("本地兼容 API 在没有保存模型名时使用中性默认名", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, ".cursor/secrets/model.env", "MODEL_ACTIVE_PROVIDER=local\n");

  const result = powershell(`$ErrorActionPreference='Stop'; . ${quote(modelScript)}; Import-ModelConfig -Root ${quote(root)}; if($script:ModelName -ne 'local-model'){throw 'local model default is not neutral'}`);

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("发布隐私门禁会检查隐藏目录并拒绝非中性的本地默认模型", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, ".cursor/skills/fit-letters/scripts/model-call.ps1", `
if ($provider -eq "local") {
  $prefix = "MODEL_LOCAL"
  $defaultModel = "personal-fixture-model"
}
`);

  const result = runPrivacyGate(root);

  assert.notEqual(result.status, 0, "non-neutral model default was accepted");
  assert.match(result.stdout + result.stderr, /neutral local model default|中性/u);
  assert.doesNotMatch(result.stdout + result.stderr, /personal-fixture-model/u);
});

test("发布隐私门禁拒绝 UserData、secrets 和数据库状态文件", async t => {
  for (const name of [
    "UserData/desktop-settings.json",
    ".cursor/secrets/model.env",
    "database/olivia-local.sqlite",
  ]) {
    const root = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await put(root, name, "PRIVATE FIXTURE\n");

    const result = runPrivacyGate(root);

    assert.notEqual(result.status, 0, `${name} was accepted`);
    assert.match(result.stdout + result.stderr, /runtime state|运行数据/u);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE FIXTURE/u);
  }
});

test("发布隐私门禁拒绝用户绝对路径、私网地址和非空 API Key", async t => {
  const cases = [
    ["docs/private-path.txt", "D:\\Users\\ExamplePerson\\private\\file.txt\n"],
    ["docs/private-network.txt", "MODEL_LOCAL_BASE=http://192.168.50.9:8000/v1\n"],
    ["docs/private-key.txt", "MODEL_DEEPSEEK_API_KEY=sk-fixture-value-1234567890\n"],
  ];
  for (const [name, content] of cases) {
    const root = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await put(root, name, content);

    const result = runPrivacyGate(root);

    assert.notEqual(result.status, 0, `${name} was accepted`);
    assert.match(result.stdout + result.stderr, /private content|隐私/u);
    assert.doesNotMatch(result.stdout + result.stderr, /ExamplePerson|192\.168\.50\.9|sk-fixture/u);
  }
});

test("发布隐私门禁接受中性模型默认值和公开示例配置", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, ".cursor/skills/fit-letters/scripts/model-call.ps1", `
if ($provider -eq "local") {
  $prefix = "MODEL_LOCAL"
  $defaultBase = "http://127.0.0.1:8000/v1"
  $defaultModel = "local-model"
}
`);
  await put(root, "docs/example.txt", "Public package example only.\n");

  const result = runPrivacyGate(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("当前发布源中的两套本地模型默认值通过中性配置门禁", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, ".cursor/skills/fit-letters/scripts/model-call.ps1", await readFile(modelScript, "utf8"));
  await put(root, "app/model-config.js", await readFile(join(project, "model-config.js"), "utf8"));

  const result = runPrivacyGate(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("发布隐私门禁扫描无扩展名、source map 和 UTF-16 二进制字符串", async t => {
  const privateRoot = "C:\\Users\\PrivacyFixture\\source";
  const cases = [
    ["assets/NOTICE", Buffer.from(`prefix ${privateRoot} suffix`, "utf8")],
    ["assets/application.js.map", Buffer.from(`prefix ${privateRoot.replaceAll("\\", "/")} suffix`, "utf8")],
    ["assets/native.bin", Buffer.from(`prefix ${privateRoot} suffix`, "utf16le")],
    ["assets/odd-offset.bin", Buffer.concat([Buffer.from([0xff]), Buffer.from(privateRoot, "utf16le")])],
  ];
  for (const [name, content] of cases) {
    const root = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await putBytes(root, name, content);

    const result = runPrivacyGate(root, { forbiddenValues: [privateRoot] });

    assert.notEqual(result.status, 0, `${name} was accepted`);
    assert.match(result.stdout + result.stderr, /private content|隐私/u);
    assert.doesNotMatch(result.stdout + result.stderr, /PrivacyFixture/u);
  }
});

test("发布隐私门禁检查 model-call 的全部默认赋值及 model-config 默认档案", async t => {
  const cases = [
    ["late override", `
$prefix = "MODEL_LOCAL"
$defaultModel = "local-model"
$defaultModel = "personal-late-override"
`],
    ["nonliteral override", `
$prefix = "MODEL_LOCAL"
$defaultModel = "local-model"
$defaultModel = Get-Content "private-default.txt"
`],
    ["direct api key", `
$prefix = "MODEL_LOCAL"
$defaultBase = "http://127.0.0.1:8000/v1"
$defaultModel = "local-model"
$apiKey = "fixture-arbitrary-key"
`],
    ["model call private defaults", `
if ($provider -eq "deepseek") {
  $defaultBase = "https://public-gateway.example/v1"
  $defaultModel = "deepseek-chat"
  $defaultApiKey = "fixture-arbitrary-key"
} else {
  $defaultBase = "http://127.0.0.1:8000/v1"
  $defaultModel = "local-model"
  $defaultApiKey = ""
}
`],
    ["model config", `
export const DEFAULT_LOCAL_PROFILE = Object.freeze({
  provider: "local",
  baseUrl: "http://127.0.0.1:8000/v1",
  model: "personal-config-default",
});
`],
    ["remote model config", `
export const DEFAULT_DEEPSEEK_PROFILE = Object.freeze({
  provider: "deepseek",
  baseUrl: "https://private-model-gateway.example/v1",
  model: "personal-remote-default",
});
export const DEFAULT_LOCAL_PROFILE = Object.freeze({
  provider: "local",
  baseUrl: "http://127.0.0.1:8000/v1",
  model: "local-model",
});
`],
    ["profile api key model config", `
export const DEFAULT_DEEPSEEK_PROFILE = Object.freeze({
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  authMode: "bearer",
  apiKey: "fixture-arbitrary-key",
});
export const DEFAULT_LOCAL_PROFILE = Object.freeze({
  provider: "local",
  baseUrl: "http://127.0.0.1:8000/v1",
  model: "local-model",
  authMode: "none",
  apiKey: "",
});
`],
  ];
  for (const [kind, content] of cases) {
    const root = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    if (!kind.endsWith("model config")) await put(root, ".cursor/skills/fit-letters/scripts/model-call.ps1", content);
    else {
      await put(root, ".cursor/skills/fit-letters/scripts/model-call.ps1", '$prefix="MODEL_LOCAL"\n$defaultModel="local-model"\n');
      await put(root, "app/model-config.js", content);
    }

    const result = runPrivacyGate(root);

    assert.notEqual(result.status, 0, `${kind} was accepted`);
    assert.match(result.stdout + result.stderr, /neutral local model default|中性/u);
    assert.doesNotMatch(result.stdout + result.stderr, /personal-/u);
  }
});

test("model-call 的 CRLF API Key 默认行必须逐行校验且只能为空", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = (await readFile(modelScript, "utf8"))
    .replace('-Default ""', '-Default "fixture-arbitrary-key"')
    .replace(/\r?\n/gu, "\r\n");
  await put(root, ".cursor/skills/fit-letters/scripts/model-call.ps1", source);

  const result = runPrivacyGate(root);

  assert.notEqual(result.status, 0, "CRLF nonempty API Key default was accepted");
  assert.match(result.stdout + result.stderr, /PRIVACY_NEUTRAL_DEFAULT/u);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-arbitrary-key/u);
});

test("发布隐私门禁拒绝 JSON 密钥和 IPv6 私网地址", async t => {
  const cases = [
    ["json-key", '{"apiKey":"fixture-private-credential-123456"}'],
    ["json-token", '{"token":"fixture-private-token-123456"}'],
    ["json-secret", '{"secret":"fixture-private-secret-123456"}'],
    ["javascript-key", '{apiKey: "fixture-private-credential-123456"}'],
    ["javascript-token", '{token: "fixture-private-token-123456"}'],
    ["javascript-secret", '{secret: "fixture-private-secret-123456"}'],
    ["ipv6-ula", "MODEL_LOCAL_BASE=http://[fd12:3456:789a::1]:8000/v1"],
    ["ipv6-link-local", "MODEL_LOCAL_BASE=http://[fe80::1234]:8000/v1"],
  ];
  for (const [name, content] of cases) {
    const root = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await put(root, `assets/${name}.json`, content);

    const result = runPrivacyGate(root);

    assert.notEqual(result.status, 0, `${name} was accepted`);
    assert.match(result.stdout + result.stderr, /private content|隐私/u);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-private|fd12|fe80/u);
  }
});

test("发布隐私门禁拒绝代码变量中的非空凭据字面量", async t => {
  const cases = [
    ["plain-key", 'apiKey = "fixture-private-credential-123456"'],
    ["declared-token", 'const accessToken = "fixture-private-token-123456";'],
    ["powershell-secret", '$clientSecret = "fixture-private-secret-123456"'],
  ];
  for (const [name, content] of cases) {
    const root = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await put(root, `app/${name}.txt`, content);

    const result = runPrivacyGate(root);

    assert.notEqual(result.status, 0, `${name} was accepted`);
    assert.match(result.stdout + result.stderr, /private content|隐私/u);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-private/u);
  }
});

test("发布隐私门禁允许公开盘符路径和明确凭据占位符", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, ".cursor/skills/fit-letters/scripts/model-call.ps1", '$prefix="MODEL_LOCAL"\n$defaultModel="local-model"\n');
  await put(root, "docs/examples.txt", [
    "INSTALL_DIR=D:\\Games\\OliviaSoul",
    "PROFILE_EXAMPLE=C:\\Users\\YOUR_NAME\\OliviaSoul",
    "OPENAI_API_KEY=YOUR_KEY_HERE",
    "MODEL_DEEPSEEK_API_KEY=<API_KEY>",
    '{"apiKey":"<API_KEY>","token":"YOUR_KEY_HERE","secret":"placeholder"}',
    "",
  ].join("\n"));

  const result = runPrivacyGate(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("发布隐私门禁不会把代码参数默认值误判为环境密钥", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, "app/storage-migration.js", [
    "export function createMigration({",
    "  randomToken = randomUUID,",
    "  tokenLifetimeSeconds = 10 * 60,",
    "} = {}) { return { randomToken, tokenLifetimeSeconds }; }",
    "",
  ].join("\n"));

  const result = runPrivacyGate(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("通用隐私正则先用完整必要锚点预筛无关二进制块", async () => {
  const source = await readFile(join(project, "packaging/package-safety.ps1"), "utf8");
  const forbiddenScan = source.indexOf("foreach ($needle in @($ForbiddenNeedles))");
  const anchors = source.indexOf("$privacyPatternAnchors = @(");
  const earlyReturn = source.indexOf("if (-not $hasPrivacyPatternAnchor) { return }");
  const firstGenericRegex = source.indexOf("foreach ($match in [regex]::Matches($Text");

  assert.ok(forbiddenScan >= 0 && anchors > forbiddenScan, "explicit forbidden values must run before the anchor prefilter");
  assert.ok(earlyReturn > anchors && earlyReturn < firstGenericRegex, "anchorless chunks must skip only the generic regex rules");
  for (const anchor of ["Users", "/home/", "http://", "https://", "sk-", "api", "token", "secret"]) {
    assert.match(source.slice(anchors, earlyReturn), new RegExp(`['\"]${anchor.replaceAll("/", "\\/")}['\"]`, "u"));
  }
});

test("隐私锚点预筛保留全部通用拒绝分支", async t => {
  const cases = [
    ["windows-user", "C:\\Users\\ExamplePerson\\private\\file.txt"],
    ["posix-user", " /home/example-person/private/file.txt"],
    ["private-ipv4", "http://172.16.10.2:8000/v1"],
    ["tailscale", "https://example-host.ts.net/v1"],
    ["sk-token", "sk-fixture-value-1234567890"],
    ["json-secret", '{"secret":"fixture-private-secret-123456"}'],
    ["mixed-case-assignment", 'aPiKeY = "fixture-private-credential-123456"'],
    ["environment-secret", "CLIENT_SECRET=fixture-private-secret-123456"],
  ];
  for (const [name, content] of cases) {
    const root = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await put(root, `assets/${name}.txt`, content);

    const result = runPrivacyGate(root);

    assert.notEqual(result.status, 0, `${name} was accepted`);
    assert.match(result.stdout + result.stderr, /private content|隐私/u);
    assert.doesNotMatch(result.stdout + result.stderr, /ExamplePerson|example-person|fixture-private/u);
  }
});

test("隐私锚点预筛保留跨块、UTF-16 奇偏移和显式禁止值检查", async t => {
  const fixtures = [
    ["cross-boundary.bin", Buffer.concat([
      Buffer.alloc((1024 * 1024) - 4, 0x78),
      Buffer.from("http://192.168.44.2/v1", "utf8"),
    ]), []],
    ["utf16-odd.bin", Buffer.concat([
      Buffer.from([0x78]),
      Buffer.from("https://[fd12:3456:789a::1]/v1", "utf16le"),
    ]), []],
    ["explicit.bin", Buffer.from("prefix FIXTURE_PRIVATE_VALUE suffix", "utf8"), ["FIXTURE_PRIVATE_VALUE"]],
  ];
  for (const [name, bytes, forbiddenValues] of fixtures) {
    const root = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await putBytes(root, `assets/${name}`, bytes);

    const result = runPrivacyGate(root, { forbiddenValues });

    assert.notEqual(result.status, 0, `${name} was accepted`);
    assert.match(result.stdout + result.stderr, /private content|隐私/u);
    assert.doesNotMatch(result.stdout + result.stderr, /192\.168\.44\.2|fd12|FIXTURE_PRIVATE_VALUE/u);
  }
});

test("生产 trusted 文件白名单使用源码固定 SHA-256 常量", async () => {
  const source = await readFile(join(project, "packaging/build-release.ps1"), "utf8");
  const expectedPins = [
    ["nodeArchiveSha256", "c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a"],
    ["nodeExeSha256", "bae898add4643fcf890a83ad8ae56e20dce7e781cab161a53991ceba70c99ffb"],
    ["whisperTalkLlamaExeSha256", "31dbb055479cde7d05919dcabfdb7aa792f0fbb46c848e50f44aa8688c47801e"],
    ["whisperModelSha256", "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"],
    ["ffmpegExeSha256", "b25445154b6f77e46f321b0de49a3d9fe4a462a5fdb7765c1ff4a9ce9950f44e"],
    ["ffprobeExeSha256", "beec24941e9d77db32e6ce6b21731575e18c92dff4d7c04988e0d115021a8259"],
  ];
  for (const [name, hash] of expectedPins) {
    assert.match(source, new RegExp(`\\$${name}\\s*=\\s*"${hash}"`, "u"));
  }
  const trustedBlock = source.match(/\$trustedStageFiles\s*=\s*@\{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? "";
  assert.match(trustedBlock, /runtime\/node\.exe"\s*=\s*\$nodeExeSha256/u);
  assert.match(trustedBlock, /whisper-talk-llama\.exe"\s*=\s*\$whisperTalkLlamaExeSha256/u);
  assert.match(trustedBlock, /ggml-small\.bin"\s*=\s*\$whisperModelSha256/u);
  assert.match(trustedBlock, /ffmpeg\.exe"\s*=\s*\$ffmpegExeSha256/u);
  assert.match(trustedBlock, /ffprobe\.exe"\s*=\s*\$ffprobeExeSha256/u);
  assert.doesNotMatch(trustedBlock, /Get-Sha256Hash|Get-FileHash|createHash/u);
});

test("只有固定 SHA-256 匹配的第三方大文件可以跳过内容扫描", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const privateRoot = "C:\\Users\\PrivacyFixture\\source";
  const bytes = Buffer.from(`third-party fixture ${privateRoot}`, "utf8");
  const relative = "runtime/whisper/ggml-small.bin";
  await putBytes(root, relative, bytes);
  // Fixed test vector: the gate must never derive a trusted pin from the file it is about to trust.
  const hash = "8081c827de953dd76230f82edf27a3ace28daeafd2f4f6169e55fa091412daa4";

  const accepted = runPrivacyGate(root, {
    forbiddenValues: [privateRoot],
    trustedFiles: { [relative]: hash },
  });
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);

  const rejected = runPrivacyGate(root, {
    forbiddenValues: [privateRoot],
    trustedFiles: { [relative]: "0".repeat(64) },
  });
  assert.notEqual(rejected.status, 0, "mismatched trusted file hash was accepted");
  assert.match(rejected.stdout + rejected.stderr, /trusted file hash|受信文件/u);
  assert.doesNotMatch(rejected.stdout + rejected.stderr, /PrivacyFixture/u);
});

test("ZIP 审计逐 entry 对照 stage 文件集合和 SHA-256", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  const archive = join(root, "candidate.zip");
  await put(stage, ".cursor/skills/fit-letters/scripts/model-call.ps1", '$prefix="MODEL_LOCAL"\n$defaultModel="local-model"\n');
  await put(stage, "assets/NOTICE", "public fixture\n");
  let result = powershell(`$ErrorActionPreference='Stop'; Compress-Archive -Path ${quote(join(stage, "*"))} -DestinationPath ${quote(archive)}; . ${quote(safetyScript)}; Assert-PublicPackageArchive -Archive ${quote(archive)} -Stage ${quote(stage)}`);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  await put(stage, "assets/NOTICE", "changed after archive\n");
  result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; Assert-PublicPackageArchive -Archive ${quote(archive)} -Stage ${quote(stage)}`);
  assert.notEqual(result.status, 0, "ZIP hash mismatch was accepted");
  assert.match(result.stdout + result.stderr, /entry set or hash|文件集合或哈希/u);
});

test("ZIP 审计会重新扫描 entry 内容而不是只信任 stage", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  const altered = join(root, "altered");
  const archive = join(root, "altered.zip");
  const privateRoot = "C:\\Users\\ArchivePrivacyFixture\\source";
  await put(stage, "assets/NOTICE", "public fixture\n");
  await put(altered, "assets/NOTICE", `embedded ${privateRoot}\n`);

  const result = powershell(`$ErrorActionPreference='Stop'; Compress-Archive -Path ${quote(join(altered, "*"))} -DestinationPath ${quote(archive)}; . ${quote(safetyScript)}; Assert-PublicPackageArchive -Archive ${quote(archive)} -Stage ${quote(stage)} -ForbiddenValues ${psArray([privateRoot])}`);

  assert.notEqual(result.status, 0, "private ZIP entry was accepted");
  assert.match(result.stdout + result.stderr, /PRIVACY_CONTENT/u);
  assert.doesNotMatch(result.stdout + result.stderr, /ArchivePrivacyFixture/u);
});

test("ZIP 审计拒绝 traversal、反斜杠和仅大小写不同的重复 entry", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  await put(stage, "assets/NOTICE", "public fixture\n");
  const cases = [
    ["traversal", ["../escape.txt"]],
    ["backslash", ["assets\\NOTICE"]],
    ["case-duplicate", ["assets/NOTICE", "Assets/notice"]],
  ];
  for (const [name, entries] of cases) {
    const archive = join(root, `${name}.zip`);
    const create = `$zip=[IO.Compression.ZipFile]::Open(${quote(archive)},[IO.Compression.ZipArchiveMode]::Create); try { foreach($name in ${psArray(entries)}) { $entry=$zip.CreateEntry($name); $stream=$entry.Open(); try { $bytes=[Text.Encoding]::UTF8.GetBytes('public fixture'); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() } } } finally { $zip.Dispose() };`;
    const result = powershell(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; ${create} . ${quote(safetyScript)}; Assert-PublicPackageArchive -Archive ${quote(archive)} -Stage ${quote(stage)}`);
    assert.notEqual(result.status, 0, `${name} ZIP was accepted`);
    assert.match(result.stdout + result.stderr, /PRIVACY_ARCHIVE_MISMATCH/u);
  }
});

test("候选 ZIP 明确包含普通隐藏路径并继续接受内容审计", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  const candidate = join(root, "work/candidate.zip");
  const audited = join(root, "work/audited.zip");
  await put(stage, ".hidden/config", "public hidden fixture\n");

  const result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; $null=Publish-AuditedPackageArchive -Stage ${quote(stage)} -CandidateArchive ${quote(candidate)} -DestinationArchive ${quote(audited)}; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead(${quote(audited)}); try { if(-not $zip.GetEntry('.hidden/config')) { throw 'hidden entry missing' } } finally { $zip.Dispose() }`);

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("发布 hook 在隐私失败时不创建最终 ZIP 或输出目录", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  const candidate = join(root, "work/candidate.zip");
  const destination = join(root, "output/OliviaSoul.zip");
  await put(stage, ".cursor/skills/fit-letters/scripts/model-call.ps1", '$prefix="MODEL_LOCAL"\n$defaultModel="personal-hook-model"\n');

  const result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; Publish-AuditedPackageArchive -Stage ${quote(stage)} -CandidateArchive ${quote(candidate)} -DestinationArchive ${quote(destination)}`);

  assert.notEqual(result.status, 0, "private stage was published");
  assert.match(result.stdout + result.stderr, /PRIVACY_NEUTRAL_DEFAULT/u);
  assert.doesNotMatch(result.stdout + result.stderr, /CommandNotFoundException|personal-hook-model/u);
  await assert.rejects(access(destination));
  await assert.rejects(access(dirname(destination)));
});

test("冻结 stage 快照必须与审计源逐文件一致", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceStage = join(root, "source-stage");
  const snapshotStage = join(root, "work/frozen-stage");
  await put(sourceStage, "app/public.txt", "public fixture\n");
  await put(sourceStage, ".hidden/config", "hidden fixture\n");

  const result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; $receipt=New-AuditedPackageSnapshot -SourceStage ${quote(sourceStage)} -SnapshotStage ${quote(snapshotStage)}; if([string]::IsNullOrWhiteSpace($receipt.Fingerprint)){throw 'snapshot fingerprint missing'}; if(-not(Test-Path -LiteralPath ${quote(join(snapshotStage, ".hidden/config"))})){throw 'hidden snapshot file missing'}`);

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("最终发布拒绝审计后变化的候选目录且不创建 OutputDirectory", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "work/release-candidate");
  const output = join(root, "final/OliviaSoul-release");
  await put(candidate, "OliviaSoul.zip", "audited bytes\n");

  const result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; $manifest=Get-PublicPackageTreeManifest -Path ${quote(candidate)}; $fingerprint=Get-PackageManifestFingerprint $manifest; [IO.File]::AppendAllText(${quote(join(candidate, "OliviaSoul.zip"))},'changed'); Publish-VerifiedReleaseDirectory -CandidateDirectory ${quote(candidate)} -OutputDirectory ${quote(output)} -ExpectedFingerprint $fingerprint`);

  assert.notEqual(result.status, 0, "mutated release candidate was published");
  assert.match(result.stdout + result.stderr, /PRIVACY_RELEASE_MUTATED/u);
  assert.doesNotMatch(result.stdout + result.stderr, /CommandNotFoundException|not recognized as the name/u);
  await assert.rejects(access(output));
});

test("最终发布只原子公开与候选目录完全一致的已审计字节", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "work/release-candidate");
  const output = join(root, "final/OliviaSoul-release");
  await put(candidate, "OliviaSoul.zip", "audited bytes\n");
  await put(candidate, ".hidden/NOTICE", "hidden public bytes\n");

  const result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; $manifest=Get-PublicPackageTreeManifest -Path ${quote(candidate)}; $fingerprint=Get-PackageManifestFingerprint $manifest; Publish-VerifiedReleaseDirectory -CandidateDirectory ${quote(candidate)} -OutputDirectory ${quote(output)} -ExpectedFingerprint $fingerprint`);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(join(output, "OliviaSoul.zip"), "utf8"), "audited bytes\n");
  assert.equal(await readFile(join(output, ".hidden/NOTICE"), "utf8"), "hidden public bytes\n");
});

test("最终发布对已完成内容审计的大文件只复核固定 SHA-256", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "work/release-candidate");
  const output = join(root, "final/OliviaSoul-release");
  const privateRoot = "C:\\Users\\PrivacyFixture\\source";
  const trustedHash = "8081c827de953dd76230f82edf27a3ace28daeafd2f4f6169e55fa091412daa4";
  await put(candidate, "OliviaSoul.zip", `third-party fixture ${privateRoot}`);
  await put(candidate, "NOTICE.txt", "public notice\n");

  const result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; $trusted=@{'OliviaSoul.zip'='${trustedHash}'}; $manifest=Get-PublicPackageTreeManifest -Path ${quote(candidate)} -ForbiddenValues @(${quote(privateRoot)}) -TrustedFiles $trusted; $fingerprint=Get-PackageManifestFingerprint $manifest; Publish-VerifiedReleaseDirectory -CandidateDirectory ${quote(candidate)} -OutputDirectory ${quote(output)} -ExpectedFingerprint $fingerprint -ForbiddenValues @(${quote(privateRoot)}) -TrustedFiles $trusted`);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(join(output, "OliviaSoul.zip"), "utf8"), `third-party fixture ${privateRoot}`);
  assert.equal(await readFile(join(output, "NOTICE.txt"), "utf8"), "public notice\n");
});

test("安装器来源证明拒绝审计 stage 之外的附加载荷", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  await put(stage, "app/public.txt", "public\n");
  const safeIss = await put(root, "safe.iss", '[Files]\nSource: "{#StageDir}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs\n');
  const unsafeIss = await put(root, "unsafe.iss", '[Files]\nSource: "{#StageDir}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs\nSource: "D:\\extra\\*"; DestDir: "{app}"; Flags: recursesubdirs\n');
  const reorderedUnsafeIss = await put(root, "unsafe-reordered.iss", '[Files]\nSource: "{#StageDir}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs\nDestDir: "{app}"; Source: "{#StageDir}\\..\\outside.txt"; Flags: ignoreversion\n');
  const duplicateSourceIss = await put(root, "unsafe-duplicate.iss", '[Files]\nSource: "{#StageDir}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs\nSource: "{#StageDir}\\app\\public.txt"; DestDir: "{app}"; Source: "{#StageDir}\\..\\outside.txt"; Flags: ignoreversion\n');
  const unsafeDestinationIss = await put(root, "unsafe-destination.iss", '[Files]\nSource: "{#StageDir}\\app\\public.txt"; DestDir: "{userappdata}\\OutsideOlivia"; DestName: "payload.txt"; Flags: ignoreversion\n');
  const unsafeDynamicWizardIss = await put(root, "unsafe-dynamic-wizard.iss", '[Setup]\nWizardStyleFileDynamicDark={#StageDir}\\..\\outside.vsf\n[Files]\nSource: "{#StageDir}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs\n');
  const unsafeIconIss = await put(root, "unsafe-icon.iss", '[Setup]\nSetupIconFile=D:\\private\\icon.ico\n[Files]\nSource: "{#StageDir}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs\n');

  let result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; Assert-AuditedInstallerSource -InstallerScript ${quote(safeIss)} -Stage ${quote(stage)}`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; Assert-AuditedInstallerSource -InstallerScript ${quote(unsafeIss)} -Stage ${quote(stage)}`);
  assert.notEqual(result.status, 0, "installer accepted a source outside audited stage");
  assert.match(result.stdout + result.stderr, /PRIVACY_INSTALLER_SOURCE/u);
  assert.doesNotMatch(result.stdout + result.stderr, /CommandNotFoundException|not recognized as the name/u);
  result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; Assert-AuditedInstallerSource -InstallerScript ${quote(reorderedUnsafeIss)} -Stage ${quote(stage)}`);
  assert.notEqual(result.status, 0, "installer accepted an out-of-order Source parameter outside audited stage");
  assert.match(result.stdout + result.stderr, /PRIVACY_INSTALLER_SOURCE/u);
  assert.doesNotMatch(result.stdout + result.stderr, /CommandNotFoundException|outside\.txt/u);
  result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; Assert-AuditedInstallerSource -InstallerScript ${quote(duplicateSourceIss)} -Stage ${quote(stage)}`);
  assert.notEqual(result.status, 0, "installer accepted a second Source parameter in one Files entry");
  assert.match(result.stdout + result.stderr, /PRIVACY_INSTALLER_SOURCE/u);
  assert.doesNotMatch(result.stdout + result.stderr, /CommandNotFoundException|outside\.txt/u);
  result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; Assert-AuditedInstallerSource -InstallerScript ${quote(unsafeDestinationIss)} -Stage ${quote(stage)} -RequireExplicitSources`);
  assert.notEqual(result.status, 0, "installer accepted a non-canonical destination for an audited Source");
  assert.match(result.stdout + result.stderr, /PRIVACY_INSTALLER_SOURCE/u);
  result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; Assert-AuditedInstallerSource -InstallerScript ${quote(unsafeDynamicWizardIss)} -Stage ${quote(stage)}`);
  assert.notEqual(result.status, 0, "installer accepted a newer Setup file directive outside audited stage");
  assert.match(result.stdout + result.stderr, /PRIVACY_INSTALLER_SOURCE/u);
  result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; Assert-AuditedInstallerSource -InstallerScript ${quote(unsafeIconIss)} -Stage ${quote(stage)}`);
  assert.notEqual(result.status, 0, "installer accepted an embedded file outside audited stage");
  assert.match(result.stdout + result.stderr, /PRIVACY_INSTALLER_SOURCE/u);
  assert.doesNotMatch(result.stdout + result.stderr, /CommandNotFoundException|not recognized as the name/u);
});

test("安装器来源采用闭集规则并拒绝重定义、外部宏与 Languages 文件", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  await put(stage, "app/public.txt", "public\n");
  const files = '[Files]\nSource: "{#StageDir}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs\n';
  const stageDefine = '#define StageDir GetEnv("OLIVIA_SOUL_STAGE")\n';
  const cases = [
    ["redefine", stageDefine + '#undef StageDir\n#define StageDir "D:\\outside"\n' + files],
    ["external define", stageDefine + '#define ExtraDir "D:\\outside"\n' + files],
    ["include", stageDefine + '#include "D:\\outside\\payload.iss"\n' + files],
    ["inline preprocessor", stageDefine + '{# FileRead(FileOpen(AddBackslash(GetEnv("OLIVIA_SOUL_STAGE")) + "..\\outside.iss")) }\n' + files],
    ["line spanning", stageDefine + '[Setup]\nWizardBackImageFile \\\n={#StageDir}\\..\\outside.png\n' + files],
    ["sign tool", stageDefine + '[Setup]\nSignTool=private=D:\\outside\\signtool.exe $f\n' + files],
    ["signature key", stageDefine + '[ISSigKeys]\nName: PrivateKey; KeyFile: "D:\\outside\\public.ispublickey"\n' + files],
    ["languages", stageDefine + '[Languages]\nName: "zh"; MessagesFile: "D:\\outside\\Chinese.isl"\n' + files],
    ["language info", stageDefine + '[Languages]\nName: "zh"; MessagesFile: "{#StageDir}\\app\\public.txt"; InfoBeforeFile: "D:\\outside\\notice.txt"\n' + files],
  ];
  for (const [name, content] of cases) {
    const installer = await put(root, `${name}.iss`, content);
    const result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; $env:OLIVIA_SOUL_STAGE=${quote(stage)}; Assert-AuditedInstallerSource -InstallerScript ${quote(installer)} -Stage ${quote(stage)} -RequireEnvironmentBinding`);
    assert.notEqual(result.status, 0, `${name} installer source was accepted`);
    assert.match(result.stdout + result.stderr, /PRIVACY_INSTALLER_SOURCE/u);
    assert.doesNotMatch(result.stdout + result.stderr, /CommandNotFoundException|D:\\outside/u);
  }
});

test("安装器编译前 stage 必须与已发布 Portable 的审计快照一致", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  const candidate = join(root, "work/candidate.zip");
  const destination = join(root, "output/OliviaSoul.zip");
  const installer = await put(root, "safe.iss", '[Files]\nSource: "{#StageDir}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs\n');
  await put(stage, "app/public.txt", "before\n");

  const result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; $fingerprint=Publish-AuditedPackageArchive -Stage ${quote(stage)} -CandidateArchive ${quote(candidate)} -DestinationArchive ${quote(destination)}; [IO.File]::AppendAllText(${quote(join(stage, "app/public.txt"))}, 'after'); Assert-AuditedInstallerSource -InstallerScript ${quote(installer)} -Stage ${quote(stage)} -ExpectedStageFingerprint $fingerprint`);

  assert.notEqual(result.status, 0, "installer accepted a stage changed after Portable audit");
  assert.match(result.stdout + result.stderr, /PRIVACY_INSTALLER_SOURCE/u);
  assert.doesNotMatch(result.stdout + result.stderr, /CommandNotFoundException|not recognized as the name/u);
});

test("显式 ISS Source 集合必须与 audited manifest 逐文件完全一致", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "frozen-stage");
  await put(stage, "app/public.txt", "audited bytes\n");
  await put(stage, ".hidden/NOTICE", "hidden bytes\n");
  const template = await put(root, "template.iss", '[Files]\nSource: "{#StageDir}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs\n');
  const compiled = join(root, "work/compile.iss");

  const result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; $null=New-AuditedInstallerCompileScript -TemplateScript ${quote(template)} -OutputScript ${quote(compiled)} -Stage ${quote(stage)}; Assert-AuditedInstallerSource -InstallerScript ${quote(compiled)} -Stage ${quote(stage)} -RequireExplicitSources`);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const text = await readFile(compiled, "utf8");
  assert.doesNotMatch(text, /\{#StageDir\}\\\*/u);
  assert.match(text, /\{#StageDir\}\\app\\public\.txt/u);
  assert.match(text, /\{#StageDir\}\\\.hidden\\NOTICE/u);

  const incomplete = await put(root, "incomplete.iss", '[Files]\nSource: "{#StageDir}\\app\\public.txt"; DestDir: "{app}\\app"; Flags: ignoreversion\n');
  const rejected = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; Assert-AuditedInstallerSource -InstallerScript ${quote(incomplete)} -Stage ${quote(stage)} -RequireExplicitSources`);
  assert.notEqual(rejected.status, 0, "incomplete explicit Source set was accepted");
  assert.match(rejected.stdout + rejected.stderr, /PRIVACY_INSTALLER_SOURCE/u);
});

test("fake ISCC 的瞬时新增文件不会进入预先冻结的显式 Source 列表", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "frozen-stage");
  const workSetup = join(root, "work/OliviaSoul-Setup.exe");
  await put(stage, "app/public.txt", "audited bytes\n");
  const template = await put(root, "template.iss", '[Files]\nSource: "{#StageDir}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs\n');
  const compiled = join(root, "work/compile.iss");

  const result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; $receipt=New-AuditedInstallerCompileScript -TemplateScript ${quote(template)} -OutputScript ${quote(compiled)} -Stage ${quote(stage)}; $fake={ param($iss) $transient=Join-Path ${quote(stage)} 'injected.tmp'; try { [IO.File]::WriteAllText($transient,'injected'); $source=[IO.File]::ReadAllText($iss); if($source -match 'injected\\.tmp'){throw 'transient source leaked'}; $parent=Split-Path ${quote(workSetup)} -Parent; [IO.Directory]::CreateDirectory($parent)|Out-Null; [IO.File]::WriteAllText(${quote(workSetup)},$source) } finally { if([IO.File]::Exists($transient)){[IO.File]::Delete($transient)} } }; Invoke-AuditedInstallerCompiler -InstallerScript ${quote(compiled)} -Stage ${quote(stage)} -ExpectedStageFingerprint $receipt.StageFingerprint -RequireExplicitSources -Compiler $fake`);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(await readFile(workSetup, "utf8"), /injected\.tmp/u);
});

test("fake ISCC 无法修改或删除显式列出的冻结文件", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "frozen-stage");
  const workSetup = join(root, "work/OliviaSoul-Setup.exe");
  const deleteMarker = join(root, "work/delete-was-blocked.txt");
  const listed = await put(stage, "app/public.txt", "audited bytes\n");
  const template = await put(root, "template.iss", '[Files]\nSource: "{#StageDir}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs\n');
  const compiled = join(root, "work/compile.iss");

  const result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; $receipt=New-AuditedInstallerCompileScript -TemplateScript ${quote(template)} -OutputScript ${quote(compiled)} -Stage ${quote(stage)}; $fake={ param($iss) try { [IO.File]::Delete(${quote(listed)}); throw 'listed delete unexpectedly succeeded' } catch [IO.IOException] { $parent=Split-Path ${quote(deleteMarker)} -Parent; [IO.Directory]::CreateDirectory($parent)|Out-Null; [IO.File]::WriteAllText(${quote(deleteMarker)},'blocked') }; [IO.File]::WriteAllText(${quote(listed)},'injected'); [IO.File]::WriteAllText(${quote(workSetup)},'fake setup') }; Invoke-AuditedInstallerCompiler -InstallerScript ${quote(compiled)} -Stage ${quote(stage)} -ExpectedStageFingerprint $receipt.StageFingerprint -RequireExplicitSources -Compiler $fake`);

  assert.notEqual(result.status, 0, "listed stage file was mutable during compilation");
  assert.match(result.stdout + result.stderr, /PRIVACY_INSTALLER_COMPILE/u);
  assert.doesNotMatch(result.stdout + result.stderr, /CommandNotFoundException|public\.txt/u);
  assert.equal(await readFile(deleteMarker, "utf8"), "blocked");
  await assert.rejects(access(workSetup));
});

test("build-release 在 PowerShell 5.1 拒绝未知参数且不创建最终输出", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "final-output");
  const buildScript = join(project, "packaging/build-release.ps1");
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", buildScript,
    "-ResolvePathsOnly", "-OutputDirectory", output, "-DefinitelyUnknownParameter",
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0, "unknown build parameter was accepted");
  assert.match(result.stdout + result.stderr, /DefinitelyUnknownParameter|named parameter/u);
  assert.doesNotMatch(result.stdout + result.stderr, /\{"buildTools"/u);
  await assert.rejects(access(output));
});

test("当前 Inno Setup 脚本只从绑定的审计 stage 嵌入文件", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  await put(stage, "app-v9.ico", "fixture icon\n");
  await put(stage, "installer/ChineseSimplified.isl", await readFile(join(project, "packaging/languages/ChineseSimplified.isl"), "utf8"));
  await put(stage, "installer/English.isl", await readFile(join(project, "packaging/languages/English.isl"), "utf8"));
  const installer = join(project, "packaging/OliviaSoul.iss");

  const result = powershell(`$ErrorActionPreference='Stop'; . ${quote(safetyScript)}; $env:OLIVIA_SOUL_STAGE=${quote(stage)}; Assert-AuditedInstallerSource -InstallerScript ${quote(installer)} -Stage ${quote(stage)} -RequireEnvironmentBinding`);

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("发布脚本只在 Portable、安装器及冻结 stage 全部复核后原子创建最终输出", async () => {
  const source = await readFile(join(project, "packaging/build-release.ps1"), "utf8");
  const snapshot = source.indexOf("New-AuditedPackageSnapshot");
  const archiveAudit = source.indexOf("Publish-AuditedPackageArchive");
  const installerProof = source.indexOf("Assert-AuditedInstallerSource");
  const iscc = source.indexOf("& $Iscc");
  const postInstallerProof = source.indexOf("Assert-AuditedInstallerSource", installerProof + 1);
  const finalPublish = source.indexOf("Publish-VerifiedReleaseDirectory");
  const checksum = source.indexOf("Write-ReleaseChecksums $releaseCandidateDirectory");
  const stageBinding = source.indexOf("$env:OLIVIA_SOUL_STAGE = $frozenStage");
  const explicitInstaller = source.indexOf("New-AuditedInstallerCompileScript");

  assert.ok(snapshot >= 0 && snapshot < archiveAudit, "release must package an audited frozen stage snapshot");
  assert.ok(explicitInstaller > stageBinding && explicitInstaller < iscc, "ISCC must receive a manifest-derived explicit Source list");
  assert.ok(installerProof > stageBinding && installerProof > archiveAudit && installerProof < iscc, "installer source proof must run after environment binding and before ISCC");
  assert.ok(postInstallerProof > iscc, "installer source and frozen stage must be proved again after ISCC");
  assert.ok(checksum > postInstallerProof && finalPublish > checksum, "final output must be published only after all artifact audits and checksums");
  assert.match(source, /-ForbiddenValues\s+\$forbiddenPackageValues/u);
  assert.match(source, /-TrustedFiles\s+\$trustedStageFiles/u);
  assert.match(source, /-ExpectedStageFingerprint\s+\$frozenStageFingerprint/u);
  assert.match(source, /\$releaseTrustedFiles\s*=\s*@\{[\s\S]*?Portable\.zip"\s*=\s*\$portableReceipt\.ArchiveSha256[\s\S]*?Setup\.exe"\s*=\s*\$setupHash[\s\S]*?\n\}/u);
  assert.match(source, /Get-PublicPackageTreeManifest\s+-Path\s+\$releaseCandidateDirectory[\s\S]*?-TrustedFiles\s+\$releaseTrustedFiles/u);
  assert.match(source, /Publish-VerifiedReleaseDirectory[\s\S]*?-TrustedFiles\s+\$releaseTrustedFiles/u);
  assert.match(source, /Invoke-AuditedInstallerCompiler[\s\S]*?-RequireExplicitSources[\s\S]*?& \$Iscc/u);
  assert.match(source, /\$env:OLIVIA_SOUL_OUTPUT\s*=\s*\$installerOutputDirectory/u);
  for (const value of ["$env:USERPROFILE", "$env:APPDATA", "$env:LOCALAPPDATA", "$repository", "$WorkDirectory", "$OutputDirectory"]) {
    assert.ok(source.includes(value), `missing dynamic forbidden value ${value}`);
  }
  assert.doesNotMatch(source, /\$forbiddenPackageValues\s*=\s*@\([\s\S]{0,300}\$env:USERNAME/u);
  assert.doesNotMatch(source, /Compress-Archive\s+-Path\s+\(Join-Path\s+\$stage/u);
  assert.doesNotMatch(source, /Join-Path\s+\$OutputDirectory\s+"OliviaSoul-\$version-(?:Portable\.zip|Setup\.exe)"/u);
});
