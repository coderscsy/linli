import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const runFile = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code) => { throw new Error(code); };
const quoteVdf = (value) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';

// Keep token offsets: serialization of a whole localconfig would destroy unrelated data.
function parse(text) {
  if (typeof text !== 'string' || text.length > 64 * 1024 * 1024) fail('INVALID_VDF');
  const tokens = [];
  let pos = 0;
  while (pos < text.length) {
    if (/\s/u.test(text[pos])) { pos++; continue; }
    if (text.startsWith('//', pos)) { const end = text.indexOf('\n', pos); pos = end < 0 ? text.length : end; continue; }
    const start = pos;
    const ch = text[pos++];
    if (ch === '{' || ch === '}') { tokens.push({ type: ch, start, end: pos }); continue; }
    if (ch !== '"') fail('UNSUPPORTED_VDF');
    let value = '', closed = false;
    while (pos < text.length) {
      const char = text[pos++];
      if (char === '"') { closed = true; break; }
      if (char === '\\' && (text[pos] === '"' || text[pos] === '\\')) value += text[pos++];
      else value += char;
    }
    if (!closed) fail('INVALID_VDF');
    tokens.push({ type: 'string', value, start, end: pos });
  }
  let index = 0;
  function object(depth, nested) {
    if (depth > 128) fail('INVALID_VDF');
    const children = [];
    while (index < tokens.length && tokens[index].type !== '}') {
      const key = tokens[index++], value = tokens[index++];
      if (key?.type !== 'string' || !value || !['string', '{'].includes(value.type)) fail('INVALID_VDF');
      if (value.type === 'string') children.push({ key, value });
      else children.push({ key, ...object(depth + 1, true) });
    }
    const close = nested ? tokens[index++] : null;
    if (nested && close?.type !== '}') fail('INVALID_VDF');
    return { children, close };
  }
  const result = object(0, false);
  if (index !== tokens.length) fail('INVALID_VDF');
  return result;
}
function uniqueChild(parent, key, optional = false) {
  if (!parent.children) fail('INVALID_VDF_PATH');
  const matches = parent.children.filter((item) => item.key.value.toLowerCase() === key.toLowerCase());
  if (matches.length > 1 || (!optional && matches.length !== 1)) fail('AMBIGUOUS_OR_MISSING_VDF_PATH');
  return matches[0];
}
function target(text, appId) {
  if (!/^[1-9]\d{0,9}$/u.test(String(appId))) fail('INVALID_APP_ID');
  let app = parse(text);
  for (const key of ['UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps', String(appId)]) app = uniqueChild(app, key);
  if (!app.children) fail('INVALID_APP_SECTION');
  const option = uniqueChild(app, 'LaunchOptions', true);
  if (option && !option.value) fail('INVALID_LAUNCH_OPTIONS');
  return { app, option };
}
export function readLaunchOptions(text, appId) {
  return target(text, appId).option?.value.value ?? null;
}
export function editLaunchOptions(text, appId, value) {
  if (value !== null && (typeof value !== 'string' || /[\r\n\0]/u.test(value))) fail('INVALID_LAUNCH_OPTIONS');
  const { app, option } = target(text, appId);
  if (option && value !== null) return text.slice(0, option.value.start) + quoteVdf(value) + text.slice(option.value.end);
  if (option) {
    const lineStart = text.lastIndexOf('\n', option.key.start - 1) + 1;
    const nextNewline = text.indexOf('\n', option.value.end);
    const onlyEntryOnLine = /^[\t ]*$/u.test(text.slice(lineStart, option.key.start)) && nextNewline >= 0 && /^[\t \r]*$/u.test(text.slice(option.value.end, nextNewline));
    return onlyEntryOnLine ? text.slice(0, lineStart) + text.slice(nextNewline + 1) : text.slice(0, option.key.start) + text.slice(option.value.end);
  }
  if (value === null) return text;
  const lineStart = text.lastIndexOf('\n', app.close.start - 1) + 1;
  const prefix = text.slice(lineStart, app.close.start);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  if (/^[\t ]*$/u.test(prefix)) {
    return text.slice(0, lineStart) + prefix + '\t"LaunchOptions"\t\t' + quoteVdf(value) + newline + text.slice(lineStart);
  }
  return text.slice(0, app.close.start) + ' "LaunchOptions" ' + quoteVdf(value) + ' ' + text.slice(app.close.start);
}

export function buildLaunchOptions(helperPath, previous) {
  if (!path.win32.isAbsolute(helperPath) || /["%&|<>^\r\n\0]/u.test(helperPath) || !helperPath.toLowerCase().endsWith('.exe')) fail('INVALID_HELPER_PATH');
  const prefix = `"${helperPath}" %command%`;
  if (previous === prefix) return prefix;
  if (previous?.startsWith(prefix + ' ')) {
    const suffix = previous.slice(prefix.length + 1);
    if (buildLaunchOptions(helperPath, suffix) === previous) return previous;
  }
  if (previous == null || previous.trim() === '') return prefix;
  // Plain game arguments are supported; an existing command wrapper needs human review.
  if (/[&|<>^%\r\n\0]/u.test(previous) || !/^\s*[-+]/u.test(previous)) fail('EXISTING_OPTIONS_REQUIRE_REVIEW');
  let inQuote = false, backslashes = 0;
  for (const ch of previous) {
    if (ch === '"' && backslashes % 2 === 0) inQuote = !inQuote;
    backslashes = ch === '\\' ? backslashes + 1 : 0;
  }
  if (inQuote) fail('EXISTING_OPTIONS_REQUIRE_REVIEW');
  return prefix + ' ' + previous;
}

export async function assertSteamStopped() {
  if (process.platform !== 'win32') fail('WINDOWS_REQUIRED');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let result;
  try {
    result = await runFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "if (Get-Process -Name steam,steamwebhelper -ErrorAction SilentlyContinue) { exit 23 }; exit 0"], { windowsHide: true, timeout: 15000 });
  } catch (error) { fail(error.code === 23 ? 'STEAM_RUNNING' : 'STEAM_STATE_UNAVAILABLE'); }
  return result;
}

function readText(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('UNSUPPORTED_CONFIG_ENCODING');
  return text;
}
function validateManifest(manifest, configPath, appId) {
  if (manifest?.version !== 1 || manifest.appId !== String(appId) || typeof manifest.configPath !== 'string' || path.resolve(manifest.configPath).toLowerCase() !== configPath.toLowerCase() || typeof manifest.installedOptions !== 'string' || !(manifest.originalOptions === null || typeof manifest.originalOptions === 'string')) fail('INVALID_RESTORE_MANIFEST');
}

export async function configureLaunchOptions(options, ensureStopped = assertSteamStopped) {
  const { mode, appId, helperPath, backupDirectory, manifestPath, expectedHash } = options;
  if (!['preview', 'install', 'restore'].includes(mode)) fail('INVALID_MODE');
  const configPath = path.resolve(options.configPath);
  if (mode !== 'preview') await ensureStopped();
  const originalBytes = await fs.readFile(configPath);
  const originalHash = hash(originalBytes);
  if (expectedHash && expectedHash !== originalHash) fail('CONFIG_CHANGED');
  const originalText = readText(originalBytes);
  const previous = readLaunchOptions(originalText, appId);
  let next;
  if (mode === 'restore') {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    validateManifest(manifest, configPath, appId);
    if (previous !== manifest.installedOptions) fail('OPTIONS_CHANGED');
    next = manifest.originalOptions;
  } else {
    if (!(await fs.stat(helperPath)).isFile()) fail('HELPER_MISSING');
    next = buildLaunchOptions(helperPath, previous);
  }
  const changed = next !== previous;
  if (mode === 'preview') return { mode, changed, expectedHash: originalHash, hadOptions: previous !== null };
  if (!changed) return { mode, changed: false };
  const updated = Buffer.from(editLaunchOptions(originalText, appId, next), 'utf8');
  // Audit data stays local; CLI never prints full config or option contents.
  await fs.mkdir(backupDirectory, { recursive: true });
  const identifier = new Date().toISOString().replace(/[:.]/gu, '-') + '-' + randomUUID();
  const backupPath = path.join(backupDirectory, `${identifier}.localconfig.vdf`);
  const outputManifest = path.join(backupDirectory, `${identifier}.json`);
  await fs.writeFile(backupPath, originalBytes, { flag: 'wx' });
  await fs.writeFile(outputManifest, JSON.stringify({ version: 1, configPath, appId: String(appId), originalOptions: previous, installedOptions: next, originalHash, backupPath, mode }, null, 2), { flag: 'wx' });
  const temporary = path.join(path.dirname(configPath), `.olivia-launch-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(updated); await handle.sync(); } finally { await handle.close(); }
    await ensureStopped();
    if (hash(await fs.readFile(configPath)) !== originalHash) fail('CONFIG_CHANGED');
    await fs.rename(temporary, configPath);
  } finally {
    await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
  return { mode, changed: true, backupPath, manifestPath: outputManifest, updatedHash: hash(updated) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    const allowed = new Set(['mode', 'configPath', 'appId', 'helperPath', 'backupDirectory', 'manifestPath', 'expectedHash']);
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index]?.replace(/^--/u, '');
      if (!allowed.has(key) || args[index + 1] === undefined || Object.hasOwn(options, key)) fail('INVALID_ARGUMENTS');
      options[key] = args[index + 1];
    }
    const result = await configureLaunchOptions(options);
    const output = { success: true, changed: result.changed };
    if (result.backupPath) output.backupPath = result.backupPath;
    if (result.manifestPath) output.manifestPath = result.manifestPath;
    console.log(JSON.stringify(output));
  } catch (error) {
    const code = /^[A-Z_]+$/u.test(error.message || '') ? error.message : 'CONFIG_OPERATION_FAILED';
    console.error(JSON.stringify({ error: code }));
    process.exitCode = 1;
  }
}
