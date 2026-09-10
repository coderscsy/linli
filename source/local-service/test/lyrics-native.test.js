import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('production WinForms lyrics lifecycle (isolated IPC; no game or browser)', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'lyrics-native-'));
  try {
    const framework = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
    const dotnet = process.env.DOTNET_HOST_PATH || join(process.env.ProgramFiles || 'C:\\Program Files', 'dotnet', 'dotnet.exe');
    const sdkRoot = join(dotnet, '..', 'sdk');
    const sdk = readdirSync(sdkRoot).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
    const compiler = join(sdkRoot, sdk, 'Roslyn', 'bincore', 'csc.dll');
    const exe = join(dir, 'Harness.exe');
    const files = ['./fixtures/lyrics-native/Harness.cs', '../native-host/LyricsPresenter.cs', '../native-host/LyricsOverlayForm.cs', '../native-host/LyricsBackdropForm.cs', '../native-host/LyricsAppearance.cs', '../native-host/LyricsControls.cs'].map(path => fileURLToPath(new URL(path, import.meta.url)));
    const compile = spawnSync(dotnet, [compiler, '/nologo', '/target:exe', '/nostdlib+',
      ...['mscorlib', 'System', 'System.Core', 'System.Drawing', 'System.Windows.Forms'].map(name => `/reference:${join(framework, name + '.dll')}`), `/out:${exe}`, ...files], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const run = spawnSync(exe, [], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    console.log(run.stdout.trim());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
