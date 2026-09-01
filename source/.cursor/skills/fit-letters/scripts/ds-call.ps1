# Shared DeepSeek call + file helpers. PowerShell 5.x. UTF-8 BOM.
# Dot-source this; call Initialize-Ds once, then Invoke-Ds.

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding $false
. (Join-Path $PSScriptRoot "model-call.ps1")

function Read-Utf8([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { throw "missing file: $path" }
    return [IO.File]::ReadAllText((Resolve-Path -LiteralPath $path).Path, $script:Utf8NoBom)
}

function Write-Utf8([string]$path, [string]$text) {
    $dir = [IO.Path]::GetDirectoryName($path)
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    [IO.File]::WriteAllText($path, $text.TrimEnd() + "`n", $script:Utf8NoBom)
}

function Strip-Yaml([string]$text) {
    $t = $text -replace "`r`n", "`n"
    if ($t.StartsWith("---")) {
        $rest = $t.Substring(3)
        $end = $rest.IndexOf("`n---`n")
        if ($end -ge 0) { return $rest.Substring($end + 5).Trim() }
    }
    return $t.Trim()
}

function Take-FromHeading([string]$text, [string]$heading) {
    $t = $text -replace "`r`n", "`n"
    $idx = $t.IndexOf($heading)
    if ($idx -lt 0) { return $t.Trim() }
    return $t.Substring($idx).Trim()
}

function Initialize-Ds {
    param([string]$Root)
    Import-ModelConfig -Root $Root
    $script:DsModel = $script:ModelName
    $script:DsThinking = $script:ModelThinking
    $script:DsLastFinishReason = $script:ModelLastFinishReason
    $script:DsLastUsage = $script:ModelLastUsage
}

function Set-DsThinking {
    param([Parameter(Mandatory = $true)][bool]$On)
    Set-ModelThinking -On $On
    $script:DsThinking = $On
}

function Set-DsModel {
    param([Parameter(Mandatory = $true)][string]$Model)
    Set-ModelName -Model $Model
    $script:DsModel = $script:ModelName
}

function Invoke-DsOnce {
    param(
        [Parameter(Mandatory = $true)][string]$System,
        [Parameter(Mandatory = $true)][string]$User
    )
    $content = Invoke-ModelChatOnce -System $System -User $User
    $script:DsLastFinishReason = $script:ModelLastFinishReason
    $script:DsLastUsage = $script:ModelLastUsage
    return $content
}

function Invoke-Ds {
    param(
        [Parameter(Mandatory = $true)][string]$System,
        [Parameter(Mandatory = $true)][string]$User
    )
    $content = Invoke-ModelChat -System $System -User $User
    $script:DsLastFinishReason = $script:ModelLastFinishReason
    $script:DsLastUsage = $script:ModelLastUsage
    return $content
}

function ConvertFrom-DsJson {
    param([Parameter(Mandatory = $true)][string]$Text)
    $clean = $Text.Trim()
    if ($clean -match '(?s)^```(?:json)?\s*(.*?)\s*```$') { $clean = $Matches[1].Trim() }
    if (-not ($clean.StartsWith("{") -and $clean.EndsWith("}"))) { throw "DeepSeek JSON envelope invalid" }
    $value = $clean | ConvertFrom-Json
    if ($null -eq $value -or $value -is [array]) { throw "DeepSeek JSON object required" }
    return $value
}

function Invoke-DsJson {
    param(
        [Parameter(Mandatory = $true)][string]$System,
        [Parameter(Mandatory = $true)][string]$User
    )
    $raw = Invoke-Ds -System $System -User $User
    try {
        return ConvertFrom-DsJson -Text $raw
    }
    catch {
        $repairSystem = $System + "`n`nThe previous output was not one strict JSON object. Return only the required JSON object."
        $repairUser = $User + "`n`nInvalid previous output:`n" + $raw
        return ConvertFrom-DsJson -Text (Invoke-Ds -System $repairSystem -User $repairUser)
    }
}
