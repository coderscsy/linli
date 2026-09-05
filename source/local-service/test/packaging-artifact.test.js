import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const task = resolve(project, '../../.superpowers/sdd/2026-09-05-public-review-package');
const script = join(project, 'packaging/build-release.ps1');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
async function fixture() {
  await mkdir(join(task, 'fixtures'), { recursive: true });
  return mkdtemp(join(task, 'fixtures/package-'));
}
function powershell(command) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8' });
}
const parse = `$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile(${quote(script)},[ref]$tokens,[ref]$errors); if($errors.Count){throw $errors[0]};`;
async function put(root, name, content = '') {
  await mkdir(dirname(join(root, name)), { recursive: true });
  await writeFile(join(root, name), content);
}

// Exercises the production copy block against disk, never executes the build.
// Removing a required desktop module from the whitelist breaks import closure.
test('desktop payload closes relative JS imports and excludes adjacent personal/developer files', async () => {
  const root = await fixture();
  const source = join(root, 'source');
  const stage = join(root, 'stage');
  await put(source, 'desktop/node-host.js', 'import "./controller.js"; import "./workspace-template.js";');
  await put(source, 'desktop/controller.js', 'import "./client-backups.js"; import "./client-execution.js"; import "./client-patch-registry.js";');
  await put(source, 'desktop/uninstall-restore.js', 'import "./client-backups.js"; import "./client-patch-registry.js";');
  for (const name of ['workspace-template.js', 'client-backups.js', 'client-execution.js', 'client-patch-registry.js', 'startup-task.ps1']) await put(source, `desktop/${name}`);
  for (const name of ['.env', 'personal.sqlite', 'private.log', 'UserData/letter.txt', 'main.js']) await put(source, `desktop/${name}`, 'PRIVATE SENTINEL');
  const result = powershell(parse + `
    foreach($name in @('Ensure-Directory','Copy-PublicFile')) { $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true); . ([scriptblock]::Create($fn.Extent.Text)) }
    $project=${quote(source)}; $stage=${quote(stage)};
    $block=$ast.Find({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Body.Extent.Text.Contains('desktop\\$name')},$true);
    if(-not $block){throw 'Desktop payload block missing'}; & ([scriptblock]::Create($block.Extent.Text));`);
  assert.equal(result.status, 0, result.stderr);
  const files = await readdir(join(stage, 'app/desktop'));
  for (const name of files.filter(name => name.endsWith('.js'))) {
    const text = await readFile(join(stage, 'app/desktop', name), 'utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*)["'](\.\/[^"']+\.js)["']/g)) {
      assert.ok(files.includes(match[1].slice(2)), `${name} has unresolved runtime import ${match[1]}`);
    }
  }
  assert.deepEqual(files.sort(), [
    'client-backups.js', 'client-execution.js', 'client-patch-registry.js', 'controller.js',
    'node-host.js', 'startup-task.ps1', 'uninstall-restore.js', 'workspace-template.js',
  ].sort());
});

// Removing the guard must fail without sacrificing an existing output sentinel.
test('output guard refuses nonempty, filesystem root and project paths without mutation', async () => {
  const root = await fixture();
  const output = join(root, 'existing');
  await put(output, 'sentinel.txt', 'DO NOT DELETE');
  const helper = join(project, 'packaging/package-safety.ps1');
  const result = powershell(`$ErrorActionPreference='Stop'; if(-not(Test-Path -LiteralPath ${quote(helper)})){Write-Output 'GUARD_MISSING'; exit 2}; . ${quote(helper)};
    foreach($path in @(${quote(output)},${quote(project)},[IO.Path]::GetPathRoot(${quote(root)}))) {
      $rejected=$false; try { Assert-EmptyPackageDirectory -Path $path -ProtectedRoots @(${quote(project)}) } catch { $rejected=$true }
      if(-not $rejected){throw "Unsafe directory accepted: $path"}
    }
    Assert-EmptyPackageDirectory -Path ${quote(join(root, 'fresh'))} -ProtectedRoots @(${quote(project)});`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(join(output, 'sentinel.txt'), 'utf8'), 'DO NOT DELETE');
  assert.deepEqual(await readdir(root), ['existing']);
});

test('review guides ship verbatim both inside payload and beside archives', async () => {
  const root = await fixture();
  const guides = ['使用说明.txt', '发布说明.md', '反馈指南.md'];
  for (const name of guides) await put(root, `docs/${name}`, `PUBLIC ${name}\n`);
  const result = powershell(parse + `
    foreach($name in @('Ensure-Directory','Copy-PublicFile','Copy-ReviewGuides')) {
      $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);
      if(-not $fn){Write-Output 'GUIDE_STAGING_MISSING'; exit 2}; . ([scriptblock]::Create($fn.Extent.Text))
    }
    Copy-ReviewGuides -Source ${quote(join(root, 'docs'))} -Stage ${quote(join(root, 'stage'))} -Output ${quote(join(root, 'output'))};`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of guides) for (const directory of ['stage', 'output']) {
    assert.equal(await readFile(join(root, directory, name), 'utf8'), `PUBLIC ${name}\n`);
  }
});

// Catches missing or wrongly versioned SDK notices in the binary distribution.
test('WebView2 SDK notices follow the declared package version and ship verbatim', async () => {
  const root = await fixture();
  const projectFile = join(root, 'OliviaSoul.csproj');
  await put(root, 'OliviaSoul.csproj', '<Project><ItemGroup><PackageReference Include="Microsoft.Web.WebView2" Version="9.8.7" /></ItemGroup></Project>');
  for (const name of ['LICENSE.txt', 'NOTICE.txt']) {
    await put(root, `nuget/microsoft.web.webview2/9.8.7/${name}`, `SDK ${name}\n`);
    await put(root, `nuget/microsoft.web.webview2/1.0.0/${name}`, 'WRONG VERSION');
  }
  const result = powershell(parse + `
    foreach($name in @('Ensure-Directory','Copy-PublicFile','Copy-WebViewNotices')) {
      $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);
      if(-not $fn){Write-Output 'SDK_NOTICE_STAGING_MISSING'; exit 2}; . ([scriptblock]::Create($fn.Extent.Text))
    }
    Copy-WebViewNotices -ProjectFile ${quote(projectFile)} -NugetRoot ${quote(join(root, 'nuget'))} -Stage ${quote(join(root, 'stage'))};`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of ['LICENSE.txt', 'NOTICE.txt']) {
    assert.equal(await readFile(join(root, 'stage/licenses/WebView2', name), 'utf8'), `SDK ${name}\n`);
  }
});

test('Node ZIP staging copies only the selected runtime and license entries', async () => {
  const root = await fixture();
  await put(root, 'input/node-example/node.exe', 'NODE RUNTIME');
  await put(root, 'input/node-example/LICENSE', 'NODE LICENSE');
  await put(root, 'input/node-example/node_modules/npm/private-fixture.txt', 'DO NOT STAGE');
  const result = powershell(parse + `
    foreach($name in @('Ensure-Directory','Copy-ZipEntry')) {
      $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);
      if(-not $fn){Write-Output 'SELECTIVE_ZIP_STAGING_MISSING'; exit 2}; . ([scriptblock]::Create($fn.Extent.Text))
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem;
    [IO.Compression.ZipFile]::CreateFromDirectory(${quote(join(root, 'input'))},${quote(join(root, 'node.zip'))});
    Copy-ZipEntry -Archive ${quote(join(root, 'node.zip'))} -EntryName 'node-example/node.exe' -Destination ${quote(join(root, 'stage/node.exe'))};
    Copy-ZipEntry -Archive ${quote(join(root, 'node.zip'))} -EntryName 'node-example/LICENSE' -Destination ${quote(join(root, 'stage/NODE-LICENSE.txt'))};`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual((await readdir(join(root, 'stage'))).sort(), ['NODE-LICENSE.txt', 'node.exe']);
  assert.equal(await readFile(join(root, 'stage/node.exe'), 'utf8'), 'NODE RUNTIME');
  assert.equal(await readFile(join(root, 'stage/NODE-LICENSE.txt'), 'utf8'), 'NODE LICENSE');
});

test('optional Steam helper payload includes runtime companions but no tests or account settings', async () => {
  const root = await fixture();
  for (const name of ['README.md', 'configure.ps1', 'steam-launch-options.mjs', 'test/private.js', 'localconfig.vdf']) await put(root, `steam/${name}`, name);
  await put(root, 'compiled/OliviaSteamWaiter.exe', 'compiled fixture');
  const result = powershell(parse + `
    foreach($name in @('Ensure-Directory','Copy-PublicFile','Copy-SteamLauncherPayload')) {
      $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);
      if(-not $fn){Write-Output 'STEAM_PAYLOAD_MISSING'; exit 2}; . ([scriptblock]::Create($fn.Extent.Text))
    }
    Copy-SteamLauncherPayload -Source ${quote(join(root, 'steam'))} -Compiled ${quote(join(root, 'compiled'))} -Destination ${quote(join(root, 'stage'))};`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual((await readdir(join(root, 'stage'))).sort(), ['OliviaSteamWaiter.exe', 'README.md', 'configure.ps1', 'steam-launch-options.mjs'].sort());
});

test('media payload retains runtime import closure and excludes generation-only and personal files', async () => {
  const root = await fixture();
  const source = join(root, 'source');
  const stage = join(root, 'stage');
  for (const name of await readdir(join(project, 'midi'))) await put(source, `midi/${name}`, await readFile(join(project, 'midi', name)));
  await put(source, 'midi/private.sqlite', 'PRIVATE');
  await put(stage, 'app/storage-paths.js');
  const result = powershell(parse + `
    foreach($name in @('Ensure-Directory','Copy-PublicFile')) { $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true); . ([scriptblock]::Create($fn.Extent.Text)) }
    $project=${quote(source)}; $stage=${quote(stage)};
    $block=$ast.Find({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Body.Extent.Text.Contains('app\\midi')},$true);
    if($block){Ensure-Directory (Join-Path $stage 'app/midi')}else{$block=$ast.Find({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.Extent.Text.StartsWith('Copy-Item') -and $n.Extent.Text.Contains('app\\midi')},$true)};
    & ([scriptblock]::Create($block.Extent.Text));`);
  assert.equal(result.status, 0, result.stderr);
  const files = await readdir(join(stage, 'app/midi'));
  assert.ok(!files.some(name => ['render-pipeline.js', 'render-queue.js', 'timeline.js', 'private.sqlite'].includes(name)), 'generation-only or personal payload leaked');
  assert.ok(files.includes('duration-repair.js'));
  const appSource = await readFile(join(project, 'server.js'), 'utf8');
  for (const match of appSource.matchAll(/from\s*["']\.\/midi\/([^"']+)["']/g)) assert.ok(files.includes(match[1]), `missing server dependency ${match[1]}`);
  for (const name of files) {
    for (const match of (await readFile(join(stage, 'app/midi', name), 'utf8')).matchAll(/from\s*["'](\.[^"']+\.js)["']/g)) {
      await readFile(resolve(stage, 'app/midi', match[1]));
    }
  }
});
