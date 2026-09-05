import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { isVerifiedOptionalClientPatch } from './client-patch-registry.js';

const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
// Exact v29 inline edits from tools/patch-feapp-local.ps1. This is a verified
// transform, not a wildcard exemption for locale assets or other revisions.
const FE_V29_LOCALE_EDITS = [
  ['n="开始定制你的演奏吧～"', 'n="上传 .mid/.midi，或在本地服务导入已下载曲库。"'],
  ['c="仅支持 .mid 格式文件，大小<1MB，时长<10 分钟。仅含钢琴单一乐器，不得出现人声或其他乐器。"', 'c="支持 .mid/.midi，单文件最大 64 MiB，不限次数。只有 MIDI 时，本地服务会按音符生成可播放 MP4。"'],
  ['r="由音频文件直接转出的 .mid 可能演奏准确度较低；如有钢琴踏板延音，需以竖线标识体现。"', 'r="已下载的分享码曲目可在本地服务中导入；生成文件保存在 MIDI 数据目录，播放缓存跟随曲目存储路径。"'],
  ['st="可以通过上传指定格式的音乐文件或使用分享码，开启你的个性化创作体验。"', 'st="上传 .mid/.midi 即可生成本地演奏；已下载的分享码曲目可通过本地曲库导入恢复。"'],
  ['Ft="为了获得最佳效果，请上传钢琴独奏的单轨 MIDI，避免包含人声或其他乐器。详见"', 'Ft="上传 .mid 或 .midi 后会按音符生成本地演奏视频；生成期间可以关闭弹窗。详见"'],
  ['Gt="《MIDI 定制演奏上传攻略》"', 'Gt="《本地 MIDI 使用说明》"'],
  ['Tt="• 仅支持 .mid 格式的 MIDI 文件，包含 1–2 条轨道，文件大小 < 1MB，乐曲时长 < 10 分钟。"', 'Tt="• 支持 .mid/.midi，单文件最大 64 MiB，不限次数；建议包含完整的速度、音符和踏板事件。"'],
  ['Vt="• 不建议直接由音频转 MIDI，可能会影响演奏准确性。请确保上传的音乐不侵犯第三方版权。"', 'Vt="• 只有 MIDI 也可以上传，本地服务会自动生成钢琴音频和演奏视频，完成后进入“我的上传”。"'],
  ['Wt="• MIDI 中只能使用钢琴单一乐器，不得包含人声或其他乐器；如有踏板延音，需在 MIDI 中用竖线标注。"', 'Wt="• 生成文件保存在本地服务显示的 MIDI 数据目录；播放缓存会跟随设置中的曲目存储路径自动加载。"'],
  ['Un="文件大小必须小于5MB"', 'Un="MIDI 文件不能超过 64 MiB"'],
  ['Cn="文件格式必须为.mid"', 'Cn="请选择 .mid 或 .midi 文件"'],
];
async function exists(path) {
  try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('backup source is not a regular file'); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function atomicStage(path, bytes) {
  const temporary = join(dirname(path), `.native-backup-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, path); }
    catch (error) {
      if (error.code !== 'EEXIST' || !await exists(path) || hash(await readFile(path)) !== hash(bytes))
        throw new Error('native backup staging conflict', { cause: error });
    }
  } finally { await rm(temporary, { force: true }); }
}

// Use the same Windows ZIP implementation as the existing status/restore scripts.
// Hash decompressed bytes, not compressed records; cap both resource use and wait.
async function archive(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 268435456) throw new Error('backup archive size limit or unsafe file');
  const bytes = await readFile(path);
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding $false;
Add-Type -AssemblyName System.IO.Compression;
$bytes=[IO.File]::ReadAllBytes(${literal(path)}); if($bytes.Length -gt 268435456){throw 'archive too large'};
$sha=[Security.Cryptography.SHA256]::Create();
$stream=New-Object IO.MemoryStream(,$bytes);
$zip=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Read,$false);
try {
  if($zip.Entries.Count -gt 10000){throw 'too many entries'};
  $total=0L; $entries=@(foreach($entry in $zip.Entries){
    $total += $entry.Length; if($total -gt 536870912 -or $entry.Length -gt 134217728){throw 'expanded archive too large'};
    $entryStream=$entry.Open(); $out=New-Object IO.MemoryStream;
    try { $entryStream.CopyTo($out); $content=$out.ToArray();
      $text=[Text.Encoding]::UTF8.GetString($content);
      [ordered]@{
        name=$entry.FullName; hash=([BitConverter]::ToString($sha.ComputeHash($content))).Replace('-','').ToLowerInvariant(); patched=$text.Contains('OliviaSoulPatch');
        knownFeLocalePatch=($entry.FullName -match '^assets/main-[^/]+[.]js$' -and ($text.StartsWith('/*OliviaSoulPatch:mail-music-v29*/') -or $text.StartsWith('/*OliviaSoulPatch:mail-music-v30*/') -or $text.StartsWith('/*OliviaSoulPatch:mail-music-v31*/') -or $text.StartsWith('/*OliviaSoulPatch:mail-music-v32*/')));
        localeBase64=if($entry.FullName -match '^assets/zh-cn-[^/]+[.]js$' -and $content.Length -le 1048576){[Convert]::ToBase64String($content)}else{$null}
      }
    } finally { $entryStream.Dispose(); $out.Dispose() }
  });
  [ordered]@{ hash=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant(); entries=$entries } | ConvertTo-Json -Depth 5 -Compress
} finally { $zip.Dispose(); $stream.Dispose(); $sha.Dispose() }`;
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    const info = JSON.parse(stdout.replace(/^\uFEFF/u, ''));
    if (info.hash !== hash(bytes)) throw new Error('archive changed during validation');
    const entries = info.entries;
    if (!Array.isArray(entries) || new Set(entries.map(e => e.name)).size !== entries.length) throw new Error('duplicate archive entries');
    const mains = entries.filter(e => /^assets\/main-[^/]+\.js$/u.test(e.name));
    if (mains.length !== 1) throw new Error('archive requires exactly one main asset');
    return { bytes, hash: info.hash, entries, main: mains[0].name, knownFeLocalePatch: mains[0].knownFeLocalePatch === true, patched: entries.some(e => e.patched) };
  } catch (error) { throw new Error(`backup archive validation failed: ${error.killed ? 'read timed out after 15 seconds' : (error.stderr || error.message).slice(0, 1000)}`, { cause: error }); }
}
function matchesKnownFeLocale(original, current) {
  if (typeof original.localeBase64 !== 'string') return false;
  try {
    // Like ReadAllText/WriteAllText with UTF8Encoding(false), consume any UTF-8
    // BOM on input and emit no BOM. Invalid UTF-8 is never an accepted identity.
    let text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(original.localeBase64, 'base64'));
    for (const [from, to] of FE_V29_LOCALE_EDITS) {
      if (text.split(from).length !== 2 || text.includes(to)) return false;
      text = text.replace(from, to);
    }
    return hash(Buffer.from(text, 'utf8')) === current.hash;
  } catch { return false; }
}
function sameIdentity(original, current, allowKnownFeLocale = false) {
  if (original.main !== current.main || original.entries.length !== current.entries.length) return false;
  const entries = new Map(current.entries.map(e => [e.name, e]));
  const nonMain = original.entries.filter(e => e.name !== original.main && !e.name.endsWith('/'));
  const locales = original.entries.filter(e => /^assets\/zh-cn-[^/]+\.js$/u.test(e.name));
  return nonMain.length > 0 && original.entries.every(e => entries.has(e.name) && (
    e.name === original.main || e.hash === entries.get(e.name).hash
    || (allowKnownFeLocale && locales.length === 1 && e.name === locales[0].name
      && matchesKnownFeLocale(e, entries.get(e.name)))
  ));
}

export async function inspectClientArchive(path) {
  return archive(path);
}

export function sameClientArchiveIdentity(original, current, { allowKnownFeLocale = false } = {}) {
  return sameIdentity(original, current, allowKnownFeLocale);
}
function unique(items, stage) {
  if (!items.length) return null;
  if (new Set(items.map(item => item.hash)).size !== 1) throw new Error(`backup ${stage}: ambiguous originals`);
  return items[0];
}

function nativeLayouts(layout) {
  return [
    { kind: 'studioUi', name: `NutStudioUI-${layout.version}.dll`, target: join(layout.gameRoot, layout.version, 'plugins', 'Studio', 'NutStudioUI.dll') },
    { kind: 'containerPlugin', name: `NutContainerPlugin-${layout.version}.dll`, target: join(layout.gameRoot, layout.version, 'plugins', 'Container', 'NutContainerPlugin.dll') },
  ];
}

async function planVerifiedNativeBackups({ layout, dirs, staged }) {
  const plans = [], files = [];
  for (const item of nativeLayouts(layout)) {
    const sources = [];
    for (const dir of dirs) {
      const path = join(dir, item.name);
      if (await exists(path)) sources.push({ path, bytes: await readFile(path) });
    }
    if (sources.length === 0) continue;
    if (new Set(sources.map(source => hash(source.bytes))).size !== 1) throw new Error(`native backup ${item.kind} conflict or ambiguity`);
    if (!await exists(item.target)) throw new Error(`native backup ${item.kind} target missing`);
    const targetBytes = await readFile(item.target), original = sources[0].bytes;
    if (!original.equals(targetBytes) && !isVerifiedOptionalClientPatch(item.kind, original, targetBytes))
      throw new Error(`native backup ${item.kind} does not prove an exact Olivia transform`);
    const stagedPath = join(staged, item.name);
    if (!await exists(stagedPath) && !original.equals(targetBytes)) plans.push({ path: stagedPath, bytes: original });
    if (!original.equals(targetBytes)) files.push({ kind: item.kind, target: item.target, backup: stagedPath });
  }
  return { plans, files };
}

async function assertSafeOptionalStagingPath(dataDir, staged) {
  const trustedRoot = resolve(dataDir);
  for (const path of [trustedRoot, join(trustedRoot, 'client-backups'), join(trustedRoot, 'client-backups', 'resources-only'), staged]) {
    let stat;
    try { stat = await lstat(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('native backup staging directory is unsafe');
    const actual = resolve(await realpath(path));
    const relation = relative(trustedRoot, actual);
    if (resolve(path).toLowerCase() !== actual.toLowerCase()
      || (path !== trustedRoot && (relation === '' || relation.startsWith('..') || isAbsolute(relation))))
      throw new Error('native backup staging directory escapes through a reparse point');
  }
}

export async function planVerifiedOptionalClientBackups({ layout, dataDir, appData, roamingAppData = process.env.APPDATA }) {
  const key = createHash('md5').update(`${layout.gameRoot.toLowerCase()}\n${layout.version.toLowerCase()}`).digest('hex');
  const managed = join(dataDir, 'client-backups'), staged = join(managed, 'resources-only', key);
  await assertSafeOptionalStagingPath(dataDir, staged);
  const dirs = [...new Set([staged, managed, appData && join(appData, 'client-backups'), roamingAppData && join(roamingAppData, 'OliviaSoul', 'client-backups')]
    .filter(Boolean).map(path => resolve(path)))];
  const { plans, files } = await planVerifiedNativeBackups({ layout, dirs, staged });
  return { dataDir: resolve(dataDir), staged, layout: { ...layout }, dirs, plans, files };
}

export async function commitVerifiedOptionalClientBackups(plan) {
  await assertSafeOptionalStagingPath(plan.dataDir, plan.staged);
  const refreshed = await planVerifiedNativeBackups({ layout: plan.layout, dirs: plan.dirs, staged: plan.staged });
  const identity = files => files.map(file => `${file.kind}\n${resolve(file.target).toLowerCase()}\n${resolve(file.backup).toLowerCase()}`).sort();
  if (JSON.stringify(identity(refreshed.files)) !== JSON.stringify(identity(plan.files)))
    throw new Error('native backup staging source or target changed after preflight');
  const expected = new Map(plan.plans.map(item => [resolve(item.path).toLowerCase(), hash(item.bytes)]));
  for (const item of refreshed.plans) {
    if (expected.get(resolve(item.path).toLowerCase()) !== hash(item.bytes))
      throw new Error('native backup staging source changed after preflight');
  }
  if (refreshed.plans.length > 0) await mkdir(plan.staged, { recursive: true });
  for (const item of refreshed.plans) await atomicStage(item.path, item.bytes);
  return refreshed.plans.map(item => item.path);
}

export async function stageVerifiedOptionalClientBackups(options) {
  const plan = await planVerifiedOptionalClientBackups(options);
  return commitVerifiedOptionalClientBackups(plan);
}

export async function resolveClientBackups({ layout, dataDir, appData, roamingAppData = process.env.APPDATA, createOnMount = false, readFeappStatus, readWebplayerStatus }) {
  const key = createHash('md5').update(`${layout.gameRoot.toLowerCase()}\n${layout.version.toLowerCase()}`).digest('hex');
  const oldKey = createHash('md5').update(layout.gameRoot.toLowerCase()).digest('hex');
  const managed = join(dataDir, 'client-backups');
  const staged = join(managed, 'resources-only', key);
  const dirs = [...new Set([staged, managed, appData && join(appData, 'client-backups'), roamingAppData && join(roamingAppData, 'OliviaSoul', 'client-backups')].filter(Boolean).map(p => resolve(p)))];
  const [stagedFe, stagedWp] = await Promise.all(['feapp', 'webplayer'].map(kind => exists(join(staged, `${key}.${kind}.dat`))));
  if (stagedFe !== stagedWp) throw new Error('backup staging incomplete pair conflict');
  // An already registered pair is independent of external originals. Selection
  // still flows through every clean, identity, mount, and staging check below.
  const completeStagedPair = stagedFe && stagedWp;
  const cache = new Map();
  const inspect = async path => { if (!cache.has(path)) cache.set(path, archive(path)); return cache.get(path); };
  const clean = async (path, readStatus) => {
    const [info, status] = await Promise.all([inspect(path), readStatus(path)]);
    if (status.clientFound !== true || status.mounted || status.managed || status.updateAvailable || info.patched) {
      const filename = basename(path).replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 80);
      const resolvedPath = resolve(path).toLowerCase(), sourceDirectory = dirname(resolvedPath);
      const source = [layout.feappPath, layout.webplayerPath].some(current => resolve(current).toLowerCase() === resolvedPath)
        ? 'current' : [
          ['staged', staged], ['managed', managed],
          ['app-data', appData && join(appData, 'client-backups')],
          ['roaming', roamingAppData && join(roamingAppData, 'OliviaSoul', 'client-backups')],
        ].find(([, directory]) => directory && resolve(directory).toLowerCase() === sourceDirectory)?.[0] ?? 'unknown';
      const diagnostic = {
        filename, hash: info.hash, source, fileBytes: info.bytes.length,
        markerEntries: info.entries.filter(entry => entry.patched).slice(0, 8)
          .map(entry => entry.name.length <= 160 && /^assets\/[A-Za-z0-9._-]+[.]js$/u.test(entry.name) ? entry.name : '[redacted]'),
        currentFeHash: currentFe.hash, currentWebplayerHash: currentWp.hash,
      };
      for (const field of ['clientFound', 'mounted', 'managed', 'updateAvailable', 'revision']) {
        const value = status[field], type = typeof value;
        const safe = value === null || type === 'boolean' || value === 'true' || value === 'false'
          || (field === 'revision' && type === 'string' && /^v\d{1,12}$/u.test(value));
        diagnostic[field] = { value: safe ? value : value === undefined ? 'undefined' : '[redacted]', type };
      }
      diagnostic.archiveMarker = Boolean(info.patched);
      console.error('[client-backup]', JSON.stringify(diagnostic));
      const reasons = ['clientFound', 'mounted', 'managed', 'updateAvailable']
        .filter(field => field === 'clientFound' ? status[field] !== true : status[field])
        .map(field => `${field}=${diagnostic[field].value}:${diagnostic[field].type}`);
      if (info.patched) reasons.push('archiveMarker=true');
      throw new Error(`backup original is invalid or patched: ${filename}; ${reasons.join(',')}`.slice(0, 220));
    }
    return info;
  };
  const currentFe = await inspect(layout.feappPath), currentWp = await inspect(layout.webplayerPath);
  let knownFeLocale;
  async function sameFeIdentity(original) {
    if (sameIdentity(original, currentFe)) return true;
    if (knownFeLocale === undefined) {
      const status = await readFeappStatus(layout.feappPath);
      knownFeLocale = currentFe.knownFeLocalePatch && status.clientFound === true && status.managed === true
        && (status.mounted === true || status.updateAvailable === true)
        && ['v29', 'v30', 'v31', 'v32'].includes(status.revision);
    }
    return sameIdentity(original, currentFe, knownFeLocale);
  }
  async function exact(kind, readStatus, current) {
    const found = [];
    for (const dir of completeStagedPair ? [staged] : dirs) {
      const path = join(dir, `${key}.${kind}.dat`);
      if (await exists(path)) {
        const info = await clean(path, readStatus);
        if (!(kind === 'feapp' ? await sameFeIdentity(info) : sameIdentity(info, current)))
          throw new Error(`backup ${kind} archive identity mismatch`);
        found.push(info);
      }
    }
    if (completeStagedPair && found.length !== 1) throw new Error('backup staging pair changed during validation');
    return unique(found, kind);
  }
  let feapp = await exact('feapp', readFeappStatus, currentFe);
  if (!feapp) {
    const old = [];
    for (const dir of dirs.slice(1)) {
      const path = join(dir, `${oldKey}.feapp.dat`);
      if (await exists(path)) { const info = await clean(path, readFeappStatus); if (!await sameFeIdentity(info)) throw new Error('backup FE archive identity mismatch'); old.push(info); }
    }
    feapp = unique(old, 'feapp');
  }
  if (!feapp && createOnMount) feapp = await clean(layout.feappPath, readFeappStatus);
  if (!feapp) throw new Error('backup FE original missing for current version');
  let webplayer = await exact('webplayer', readWebplayerStatus, currentWp);
  if (!webplayer) {
    let files = [];
    try { files = await readdir(managed); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const matches = [];
    for (const name of files.filter(n => /^[a-f0-9]{32}\.feapp\.dat$/u.test(n) && n !== `${key}.feapp.dat`)) {
      const fePath = join(managed, name), wpPath = join(managed, name.replace('.feapp.dat', '.webplayer.dat'));
      if (!(await exists(fePath)) || hash(await readFile(fePath)) !== feapp.hash || !(await exists(wpPath))) continue;
      await clean(fePath, readFeappStatus);
      const info = await clean(wpPath, readWebplayerStatus);
      if (!sameIdentity(info, currentWp)) throw new Error('backup WP archive identity mismatch');
      matches.push(info);
    }
    webplayer = unique(matches, 'webplayer');
  }
  if (!webplayer && createOnMount) webplayer = await clean(layout.webplayerPath, readWebplayerStatus);
  if (!webplayer) throw new Error('backup WP original missing or association unknown');

  // A clean current archive and its verified original must agree byte-for-byte
  // before mount. Staged originals remain immutable inputs to the mount scripts.
  if (createOnMount) {
    for (const [path, readStatus, original] of [[layout.feappPath, readFeappStatus, feapp], [layout.webplayerPath, readWebplayerStatus, webplayer]]) {
      const status = await readStatus(path);
      if (!status.mounted && !status.managed && !status.updateAvailable) {
        const current = await clean(path, readStatus);
        if (current.hash !== original.hash) throw new Error('backup clean current original conflict');
      }
    }
  }

  // No writes until BOTH originals and all pre-existing target contents pass.
  const result = { feapp: join(staged, `${key}.feapp.dat`), webplayer: join(staged, `${key}.webplayer.dat`) };
  const optionalLayouts = nativeLayouts(layout);
  const allowed = new Set([`${key}.feapp.dat`, `${key}.webplayer.dat`, ...optionalLayouts.map(item => item.name)]);
  for (const dir of [managed, join(managed, 'resources-only'), staged]) {
    try { const stat = await lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('backup staging directory is unsafe'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { if ((await readdir(staged)).some(name => !allowed.has(name))) throw new Error('backup staging has unexpected sidecar'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const [kind, info] of Object.entries({ feapp, webplayer })) {
    if (await exists(result[kind]) && hash(await readFile(result[kind])) !== info.hash) throw new Error('backup staging content conflict');
  }
  const { plans: optionalToStage } = await planVerifiedNativeBackups({ layout, dirs, staged });
  await mkdir(staged, { recursive: true });
  for (const [kind, info] of Object.entries({ feapp, webplayer })) {
    try { await writeFile(result[kind], info.bytes, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST' || !(await exists(result[kind])) || hash(await readFile(result[kind])) !== info.hash) throw error; }
  }
  for (const item of optionalToStage) await atomicStage(item.path, item.bytes);
  return result;
}
