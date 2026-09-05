import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("Windows PowerShell 5 preserves the FE author separator when parsing the shipped patch script", {
  skip: process.platform !== "win32",
}, async () => {
  const script = fileURLToPath(new URL("../../tools/patch-feapp-local.ps1", import.meta.url));
  const scriptLiteral = `'${script.replaceAll("'", "''")}'`;
  // ParseFile reads the actual artifact with Windows PowerShell's encoding
  // rules. Never dot-source or invoke it: it contains game mutation commands.
  const command = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false
$tokens=$null; $parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${scriptLiteral},[ref]$tokens,[ref]$parseErrors)
$assignments=@($ast.FindAll({param($node)
  $node -is [Management.Automation.Language.AssignmentStatementAst] -and
  $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
  $node.Left.VariablePath.UserPath -eq 'songEditorRowFrom'
},$true))
if($assignments.Count -ne 1){throw 'Expected exactly one songEditorRowFrom assignment'}
$literals=@($assignments[0].Right.FindAll({param($node)
  $node -is [Management.Automation.Language.StringConstantExpressionAst]
},$true))
if($literals.Count -ne 1){throw 'Expected exactly one literal in songEditorRowFrom'}
$value=$literals[0].Value
if($value -isnot [string]){throw 'Expected a literal songEditorRowFrom string'}
[ordered]@{
  major=$PSVersionTable.PSVersion.Major
  codePage=[Text.Encoding]::Default.CodePage
  codeUnits=@($value.ToCharArray() | ForEach-Object {[int]$_})
  parseErrorCount=@($parseErrors).Count
} | ConvertTo-Json -Compress`;
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  assert.ok(windowsRoot, "Windows PowerShell location requires SystemRoot or WINDIR");
  const shell = join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // A parent PowerShell 7 module path must not change the PS5 process boundary.
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => name.toLowerCase() !== "psmodulepath"));
  const { stdout } = await execute(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(command, "utf16le").toString("base64")], {
    env: environment, windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024,
  });
  const actual = JSON.parse(stdout.replace(/^\uFEFF/u, ""));
  assert.equal(actual.major, 5, "Characterization must use Windows PowerShell 5, not pwsh");
  // Independent ASCII-encoded expectation: it cannot inherit the script's
  // decoding mistake. Losing the encoding contract corrupts U+2022 on CP936.
  const expected = 'n("p",Ox,v(X.song.originalAuthor)+" \u2022 "+v(o(G)),1)],2)';
  assert.deepEqual(actual.codeUnits, Array.from(expected, character => character.charCodeAt(0)),
    `Parser.ParseFile corrupted the literal under Windows code page ${actual.codePage}`);
  assert.equal(actual.parseErrorCount, 0, "The production patch must remain syntactically valid");
});
