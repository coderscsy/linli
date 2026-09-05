import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const iscc = process.env.ISCC_PATH;
test('real installer compiles with the staged Simplified Chinese language and no missing translations',
  { skip: !iscc || !existsSync(iscc) }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'olivia-installer-cn-'));
    const stage = join(root, 'stage'), out = join(root, 'output');
    await mkdir(join(stage, 'installer'), { recursive: true }); await mkdir(out);
    const project = new URL('../', import.meta.url);
    const { fileURLToPath } = await import('node:url');
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const packaging = fileURLToPath(new URL('packaging/', project));
    const staged = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference='Stop'; $tokens=$null; $errors=$null;
      $ast=[Management.Automation.Language.Parser]::ParseFile(${quote(join(packaging, 'build-release.ps1'))},[ref]$tokens,[ref]$errors);
      if($errors.Count){throw $errors[0]};
      foreach($name in @('Ensure-Directory','Copy-PublicFile')) { $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true); . ([scriptblock]::Create($fn.Extent.Text)) }
      $stage=${quote(stage)}; $packagingRoot=${quote(packaging)};
      $block=$ast.Find({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Body.Extent.Text.Contains('languages\\$name')},$true);
      if(-not $block){throw 'Language staging missing'}; & ([scriptblock]::Create($block.Extent.Text.Replace('$PSScriptRoot', '$packagingRoot')));
    `], { encoding: 'utf8', windowsHide: true });
    assert.equal(staged.status, 0, staged.stdout + staged.stderr);
    assert.ok(existsSync(join(stage, 'installer/LICENSE.txt')));
    assert.ok(existsSync(join(stage, 'installer/English.isl')), 'English must be included in the audited stage');
    await copyFile(new URL('packaging/app.ico', project), join(stage, 'app-v9.ico'));
    await writeFile(join(stage, 'fixture.txt'), 'Compile-only fixture, never execute this installer.');
    const script = new URL('packaging/OliviaSoul.iss', project);
    const audited = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference='Stop'; . ${quote(join(packaging, 'package-safety.ps1'))};
      Assert-AuditedInstallerSource -InstallerScript ${quote(fileURLToPath(script))} -Stage ${quote(stage)} -RequireEnvironmentBinding;
    `], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, OLIVIA_SOUL_STAGE: stage, OLIVIA_SOUL_OUTPUT: out, OLIVIA_SOUL_VERSION: '2008.2.7' } });
    assert.equal(audited.status, 0, audited.stdout + audited.stderr);
    const result = spawnSync(iscc, [fileURLToPath(script)], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, OLIVIA_SOUL_STAGE: stage, OLIVIA_SOUL_OUTPUT: out, OLIVIA_SOUL_VERSION: '2008.2.7' } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /ChineseSimplified\.isl/);
    assert.match(result.stdout, /English\.isl/);
    assert.doesNotMatch(result.stdout + result.stderr, /Warning:/i);
    assert.ok(existsSync(join(out, 'OliviaSoul-2008.2.7-Setup.exe')));
    const outside = 'D:\\outside\\notice.txt', unsafe = join(root, 'unsafe.iss');
    await writeFile(unsafe, (await readFile(script, 'utf8')).replace('installer\\ChineseSimplified.isl"', `installer\\ChineseSimplified.isl"; InfoBeforeFile: ${outside}`));
    const rejected = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference='Stop'; . ${quote(join(packaging, 'package-safety.ps1'))};
      Assert-AuditedInstallerSource -InstallerScript ${quote(unsafe)} -Stage ${quote(stage)};
    `], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(rejected.status, 0, 'unquoted extra language file outside stage must be rejected');
    assert.match(rejected.stdout + rejected.stderr, /unaudited parameters/);
  });
