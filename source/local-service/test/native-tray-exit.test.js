import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Execute verbatim production handlers. Only external UI/backend boundaries are
// replaced: constructing MainForm itself would create WebView2 and a real tray icon.
function method(source, name) {
  const lines = source.replace(/\r/g, '').split('\n');
  const start = lines.findIndex(line => /^        (public|private|protected) /.test(line) && line.includes(` ${name}(`));
  assert.notEqual(start, -1, `production method ${name} exists`);
  const end = lines.findIndex((line, index) => index > start && line === '        }');
  assert.notEqual(end, -1, `production method ${name} terminates`);
  return lines.slice(start, end + 1).join('\n');
}

test('native tray Exit lifecycle uses production handlers without launching app UI or Node', { skip: process.platform !== 'win32' }, () => {
  const main = readFileSync(new URL('../native-host/MainForm.cs', import.meta.url), 'utf8');
  const startup = readFileSync(new URL('../native-host/StartupContext.cs', import.meta.url), 'utf8');
  const backend = readFileSync(new URL('../native-host/NodeBackend.cs', import.meta.url), 'utf8');
  const fixture = readFileSync(new URL('./fixtures/native-tray-exit/Harness.cs', import.meta.url), 'utf8');
  const code = fixture.replace('/* MAIN_HANDLERS */', ['RequestQuit', 'OnFormClosing', 'HideToTray', 'ShowFromTray', 'FinishShowFromTrayAsync', 'InitializeAsync'].map(name => method(main, name)).join('\n'))
    .replace('/* IS_QUITTING */', main.split(/\r?\n/).find(line => line.includes('public bool IsQuitting ')) || 'public bool IsQuitting { get { return false; } }')
    .replace('/* STARTUP_HANDLER */', method(startup, 'Start'))
    .replace('/* BACKEND_HANDLERS */', ['StopAsync', ...(backend.includes('Task StopCoreAsync(') ? ['StopCoreAsync'] : []), 'Dispose'].map(name => method(backend, name)).join('\n'));
  const dir = mkdtempSync(join(tmpdir(), 'native-tray-exit-'));
  try {
    const source = join(dir, 'Harness.cs');
    const executable = join(dir, 'Harness.exe');
    writeFileSync(source, code);
    const framework = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
    const dotnet = process.env.DOTNET_HOST_PATH || join(process.env.ProgramFiles || 'C:\\Program Files', 'dotnet', 'dotnet.exe');
    const sdkRoot = join(dotnet, '..', 'sdk');
    const sdk = readdirSync(sdkRoot).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
    const compiler = join(sdkRoot, sdk, 'Roslyn', 'bincore', 'csc.dll');
    const compile = spawnSync(dotnet, [compiler, '/nologo', '/target:exe', '/nostdlib+', ...['mscorlib', 'System', 'System.Core'].map(name => `/reference:${join(framework, `${name}.dll`)}`), `/out:${executable}`, source], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(compile.status, 0, `isolated harness compilation failed:\n${compile.stdout}\n${compile.stderr}`);
    const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(run.status, 0, `production lifecycle regression:\n${run.stdout}\n${run.stderr}`);
    console.log(run.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
