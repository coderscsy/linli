# Call DeepSeek V4 Pro to write a Lin Li letter. PowerShell 5.x. UTF-8.
# Blind (fitting): injects rules + persona + truncated ctx; model cannot read the repo.
# Live  (user):    injects rules + persona + memory + the incoming letter.
#
#   powershell -NoProfile -File .cursor/skills/fit-letters/scripts/deepseek-reply.ps1 -Mode Blind -Ctx "_probe\ctx_example_07.md"
#   powershell -NoProfile -File .cursor/skills/fit-letters/scripts/deepseek-reply.ps1 -Mode Live -Person "example" -Letter "inbox\latest.txt"

param(
    [ValidateSet("Blind", "Live")]
    [string]$Mode = "Blind",
    [string]$Ctx = "",
    [string]$Letter = "",
    [string]$Person = "",
    [string]$OutFile = "",
    [string]$RulesFile = "",
    [string]$Root = ""
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$utf8 = New-Object System.Text.UTF8Encoding $false
. (Join-Path $PSScriptRoot "model-call.ps1")

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = (Get-Location).Path
}

function Read-Utf8([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Error "missing file: $path"
    }
    return [IO.File]::ReadAllText((Resolve-Path -LiteralPath $path).Path, $utf8)
}

function Strip-Yaml([string]$text) {
    $t = $text -replace "`r`n", "`n"
    if ($t.StartsWith("---")) {
        $rest = $t.Substring(3)
        $end = $rest.IndexOf("`n---`n")
        if ($end -ge 0) {
            return $rest.Substring($end + 5).Trim()
        }
    }
    return $t.Trim()
}

function Take-FromHeading([string]$text, [string]$heading) {
    $t = $text -replace "`r`n", "`n"
    $idx = $t.IndexOf($heading)
    if ($idx -lt 0) { return $t.Trim() }
    return $t.Substring($idx).Trim()
}

Import-ModelConfig -Root $Root

$writeHeading = "# " + [string]::Concat([char]0x5199, [char]0x6CD5)
$personaHeading = "## " + [string]::Concat([char]0x57FA, [char]0x7840)
$rulesPath = Join-Path $Root ".cursor\rules\linli-letters.mdc"
if (-not [string]::IsNullOrWhiteSpace($RulesFile)) {
    $rulesPath = $RulesFile
    if (-not [IO.Path]::IsPathRooted($rulesPath)) { $rulesPath = Join-Path $Root $RulesFile }
}
$rules = Take-FromHeading (Strip-Yaml (Read-Utf8 $rulesPath)) $writeHeading
$persona = Take-FromHeading (Read-Utf8 (Join-Path $Root "林离人设.md")) $personaHeading

$system = @"
你就是林离。按下面的规则与人设写信。
只输出回信正文本身，不要任何标签、前缀、分析、说明或英文。

# 规则
$rules

# 人设
$persona
"@

if ($Mode -eq "Blind") {
    if ([string]::IsNullOrWhiteSpace($Ctx)) {
        Write-Error "Blind mode requires -Ctx"
    }
    $ctxPath = $Ctx
    if (-not [IO.Path]::IsPathRooted($ctxPath)) {
        $ctxPath = Join-Path $Root $Ctx
    }
    $ctxText = Read-Utf8 $ctxPath
    $user = @"
下面是截断后的往来。末尾的「我（信件）」是刚收到的来信。按规则写出林离的回复正文。

$ctxText
"@
    if ([string]::IsNullOrWhiteSpace($OutFile)) {
        $name = [IO.Path]::GetFileName($ctxPath)
        $name = $name -replace "^ctx_", "gen_"
        $name = [IO.Path]::ChangeExtension($name, ".txt")
        $OutFile = Join-Path $Root ("_probe\" + $name)
    }
}
else {
    if ([string]::IsNullOrWhiteSpace($Person)) {
        Write-Error "Live mode requires -Person"
    }
    if ([string]::IsNullOrWhiteSpace($Letter)) {
        Write-Error "Live mode requires -Letter"
    }
    $letterPath = $Letter
    if (-not [IO.Path]::IsPathRooted($letterPath)) {
        $letterPath = Join-Path $Root $Letter
    }
    if ([string]::IsNullOrWhiteSpace($OutFile)) {
        $OutFile = Join-Path $Root "_probe\live_reply.txt"
    }
    $liveHarness = Join-Path $PSScriptRoot "harness-live.ps1"
    & $liveHarness -Person $Person -Letter $letterPath -OutFile $OutFile -RulesFile $rulesPath -Root $Root
    return
}

$content = Invoke-ModelChat -System $system -User $user

$outDir = [IO.Path]::GetDirectoryName($OutFile)
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir | Out-Null
}
[IO.File]::WriteAllText($OutFile, $content.Trim() + "`n", $utf8)
Write-Output ("wrote {0}" -f $OutFile)
Write-Output $content.Trim()
