# Provider-neutral OpenAI-compatible model transport. PowerShell 5.x.
# Dot-source this file, call Import-ModelConfig once, then Invoke-ModelChat.

$script:ModelUtf8NoBom = New-Object System.Text.UTF8Encoding $false

function Read-ModelEnvFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $values }
    foreach ($rawLine in [IO.File]::ReadAllLines((Resolve-Path -LiteralPath $Path).Path, $script:ModelUtf8NoBom)) {
        $line = $rawLine.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) { continue }
        $separator = $line.IndexOf("=")
        if ($separator -le 0) { continue }
        $values[$line.Substring(0, $separator).Trim()] = $line.Substring($separator + 1).Trim()
    }
    return $values
}

function Get-ModelValue {
    param(
        [hashtable]$Primary,
        [string]$PrimaryName,
        [hashtable]$Legacy,
        [string]$LegacyName,
        [string]$Default
    )
    if ($Primary.ContainsKey($PrimaryName)) { return [string]$Primary[$PrimaryName] }
    if ($Legacy -and $LegacyName -and $Legacy.ContainsKey($LegacyName)) { return [string]$Legacy[$LegacyName] }
    $environmentValue = $null
    if ($LegacyName) { $environmentValue = [Environment]::GetEnvironmentVariable($LegacyName) }
    if (-not [string]::IsNullOrWhiteSpace($environmentValue)) { return $environmentValue }
    return $Default
}

function Assert-ModelSingleLine {
    param([string]$Value, [string]$Label)
    if ($Value -match "[`r`n]") { throw "$Label cannot contain newlines" }
    return $Value.Trim()
}

function Import-ModelConfig {
    param([Parameter(Mandatory = $true)][string]$Root)
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $secrets = Join-Path $Root ".cursor\secrets"
    $config = Read-ModelEnvFile -Path (Join-Path $secrets "model.env")
    $legacy = Read-ModelEnvFile -Path (Join-Path $secrets "deepseek.env")
    $provider = Get-ModelValue -Primary $config -PrimaryName "MODEL_ACTIVE_PROVIDER" -Legacy $null -LegacyName "" -Default "deepseek"
    $provider = Assert-ModelSingleLine -Value $provider -Label "provider"
    if ($provider -notin @("deepseek", "local")) { throw "provider must be deepseek or local" }

    if ($provider -eq "deepseek") {
        $prefix = "MODEL_DEEPSEEK"
        $defaultBase = "https://api.deepseek.com"
        $defaultModel = "deepseek-v4-pro"
        $defaultAuth = "bearer"
        $legacyBase = "DEEPSEEK_BASE"
        $legacyModel = "DEEPSEEK_MODEL"
        $legacyKey = "DEEPSEEK_API_KEY"
    }
    else {
        $prefix = "MODEL_LOCAL"
        $defaultBase = "http://127.0.0.1:8000/v1"
        $defaultModel = "local-model"
        $defaultAuth = "none"
        $legacyBase = ""
        $legacyModel = ""
        $legacyKey = ""
    }

    $base = Get-ModelValue -Primary $config -PrimaryName ($prefix + "_BASE") -Legacy $legacy -LegacyName $legacyBase -Default $defaultBase
    $model = Get-ModelValue -Primary $config -PrimaryName ($prefix + "_MODEL") -Legacy $legacy -LegacyName $legacyModel -Default $defaultModel
    $authMode = Get-ModelValue -Primary $config -PrimaryName ($prefix + "_AUTH_MODE") -Legacy $null -LegacyName "" -Default $defaultAuth
    $apiKey = Get-ModelValue -Primary $config -PrimaryName ($prefix + "_API_KEY") -Legacy $legacy -LegacyName $legacyKey -Default ""
    $base = Assert-ModelSingleLine -Value $base -Label "model base URL"
    $model = Assert-ModelSingleLine -Value $model -Label "model name"
    $authMode = Assert-ModelSingleLine -Value $authMode -Label "auth mode"
    $apiKey = Assert-ModelSingleLine -Value $apiKey -Label "API key"
    if ([string]::IsNullOrWhiteSpace($model)) { throw "model name cannot be empty" }
    if ($authMode -notin @("bearer", "none")) { throw "auth mode must be bearer or none" }
    if ($authMode -eq "bearer" -and [string]::IsNullOrWhiteSpace($apiKey)) { throw "Bearer authentication requires an API key" }
    $parsed = $null
    if (-not [Uri]::TryCreate($base, [UriKind]::Absolute, [ref]$parsed) -or $parsed.Scheme -notin @("http", "https")) {
        throw "model base URL must use http or https"
    }
    if ($parsed.UserInfo -or $parsed.Query -or $parsed.Fragment) { throw "model URL must not contain credentials, query or fragment" }
    if ($parsed.AbsolutePath.TrimEnd('/') -match '/(messages|responses)$') { throw "only Chat Completions endpoints are supported" }
    $base = $base.TrimEnd('/') -replace '/chat/completions$', ''

    $script:ModelProvider = $provider
    $script:ModelUri = $base.TrimEnd("/") + "/chat/completions"
    $script:ModelName = $model
    $script:ModelAuthMode = $authMode
    $script:ModelKey = $apiKey
    $script:ModelThinking = $true
    $script:ModelLastFinishReason = ""
    $script:ModelLastUsage = $null
}

function Set-ModelThinking {
    param([Parameter(Mandatory = $true)][bool]$On)
    $script:ModelThinking = $On
}

function Set-ModelName {
    param([Parameter(Mandatory = $true)][string]$Model)
    if ([string]::IsNullOrWhiteSpace($Model)) { throw "model name cannot be empty" }
    $script:ModelName = $Model.Trim()
}

function ConvertTo-ModelBodyText {
    param($Value)
    if ($Value -is [string]) { return $Value }
    $text = New-Object Text.StringBuilder
    if ($Value -is [array]) {
        foreach ($part in $Value) {
            if ($part -is [string]) { [void]$text.Append($part) }
            elseif ($part.type -cin @('text', 'output_text') -and $part.text -is [string]) { [void]$text.Append($part.text) }
        }
    }
    return $text.ToString()
}

function Get-ModelFinalText {
    param($Payload)
    if ($Payload.error) { throw 'model response error' }
    $choice = @($Payload.choices)[0]
    if ($choice.finish_reason -in @('length', 'content_filter')) { throw 'model did not produce complete text' }
    $text = ConvertTo-ModelBodyText $choice.message.content
    if (-not [string]::IsNullOrWhiteSpace($text)) { return $text.Trim() }
    $text = ConvertTo-ModelBodyText $choice.text
    if (-not [string]::IsNullOrWhiteSpace($text)) { return $text.Trim() }
    $text = ConvertTo-ModelBodyText $Payload.output_text
    if (-not [string]::IsNullOrWhiteSpace($text)) { return $text.Trim() }
    $parts = @($Payload.output | Where-Object { -not $_.type -or $_.type -ceq 'message' } | ForEach-Object { $_.content })
    $text = ConvertTo-ModelBodyText $parts
    if (-not [string]::IsNullOrWhiteSpace($text)) { return $text.Trim() }
    throw ("{0} returned empty content (final text required)" -f $script:ModelProvider)
}

function ConvertFrom-ModelJson {
    param([string]$Raw)
    try { return ($Raw.TrimStart([char]0xFEFF) | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw 'model returned invalid JSON' }
}

function ConvertFrom-ModelResponse {
    param([string]$Raw, [string]$ContentType)
    if ($ContentType -notmatch 'text/event-stream') {
        $response = ConvertFrom-ModelJson $Raw
        $choice = @($response.choices)[0]
        $script:ModelLastFinishReason = [string]$choice.finish_reason
        $script:ModelLastUsage = $response.usage
        return Get-ModelFinalText $response
    }
    $text = New-Object Text.StringBuilder
    $ended = $false
    $script:ModelLastFinishReason = ''
    $script:ModelLastUsage = $null
    $normalized = $Raw.TrimStart([char]0xFEFF) -replace "`r`n?", "`n"
    foreach ($event in ($normalized -split "`n`n")) {
        $lines = @($event -split "`n" | Where-Object { $_.StartsWith('data:') } | ForEach-Object { $_.Substring(5) -replace '^ ', '' })
        $data = $lines -join "`n"
        if (-not $data) { continue }
        if ($data.Trim() -ceq '[DONE]') { $ended = $true; break }
        $payload = ConvertFrom-ModelJson $data
        if ($payload.error) { throw 'model stream returned error' }
        if ($payload.usage) { $script:ModelLastUsage = $payload.usage }
        $choice = @($payload.choices | Where-Object { $_.index -eq 0 })[0]
        if (-not $choice) { $choice = @($payload.choices)[0] }
        if (-not $choice) { continue }
        $part = $choice.delta.content
        if ($null -eq $part) { $part = $choice.message.content }
        if ($null -eq $part) { $part = $choice.text }
        [void]$text.Append((ConvertTo-ModelBodyText $part))
        if ($choice.finish_reason) { $script:ModelLastFinishReason = [string]$choice.finish_reason; $ended = $true }
    }
    if (-not $ended) { throw 'model stream interrupted before completion' }
    if ($script:ModelLastFinishReason -in @('length', 'content_filter')) { throw 'model stream did not produce complete text' }
    if ([string]::IsNullOrWhiteSpace($text.ToString())) { throw ("{0} returned empty content (final text required)" -f $script:ModelProvider) }
    return $text.ToString().Trim()
}

function Read-ModelResponseBody {
    param($Response)
    $stream = $Response.GetResponseStream()
    $buffer = New-Object byte[] 8192
    $memory = New-Object IO.MemoryStream
    try {
        while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if ($memory.Length + $count -gt 8388608) { throw 'model response exceeds 8 MiB' }
            $memory.Write($buffer, 0, $count)
        }
        return $script:ModelUtf8NoBom.GetString($memory.ToArray())
    }
    finally { $stream.Dispose(); $memory.Dispose() }
}

function Invoke-ModelChatOnce {
    param(
        [Parameter(Mandatory = $true)][string]$System,
        [Parameter(Mandatory = $true)][string]$User
    )
    $payload = @{
        model = $script:ModelName
        stream = $false
        messages = @(
            @{ role = "system"; content = $System }
            @{ role = "user"; content = $User }
        )
    }
    if ($script:ModelProvider -eq "deepseek" -and $script:ModelName -match '(?:^|/)deepseek(?:[-/]|$)') {
        if ($script:ModelThinking) {
            $payload.reasoning_effort = "high"
            $payload.thinking = @{ type = "enabled" }
        }
        else {
            $payload.thinking = @{ type = "disabled" }
        }
    }
    $bytes = $script:ModelUtf8NoBom.GetBytes(($payload | ConvertTo-Json -Depth 8 -Compress))
    try {
        $request = [Net.HttpWebRequest]::Create($script:ModelUri)
        $request.Method = "POST"
        $request.ContentType = "application/json; charset=utf-8"
        $request.Accept = "application/json"
        $request.AllowAutoRedirect = $false
        $request.Timeout = 500000
        $request.ReadWriteTimeout = 500000
        if ($script:ModelAuthMode -eq "bearer") {
            [void]$request.Headers.Add("Authorization", "Bearer " + $script:ModelKey)
        }
        $requestStream = $request.GetRequestStream()
        $requestStream.Write($bytes, 0, $bytes.Length)
        $requestStream.Close()
        $httpResponse = $request.GetResponse()
        try {
            if ([int]$httpResponse.StatusCode -ge 300) { throw 'model endpoint redirect is not supported' }
            $contentType = $httpResponse.ContentType
            $raw = Read-ModelResponseBody $httpResponse
        }
        finally { $httpResponse.Close() }
    }
    catch {
        $webException = $_.Exception
        if ($webException.InnerException -is [Net.WebException]) { $webException = $webException.InnerException }
        if ($webException -is [Net.WebException] -and $webException.Response) {
            $status = [int]$webException.Response.StatusCode
            $webException.Response.Close()
            throw ("{0} HTTP {1}" -f $script:ModelProvider, $status)
        }
        throw ("{0} request failed" -f $script:ModelProvider)
    }
    return ConvertFrom-ModelResponse -Raw $raw -ContentType $contentType
}

function Invoke-ModelChat {
    param(
        [Parameter(Mandatory = $true)][string]$System,
        [Parameter(Mandatory = $true)][string]$User
    )
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            return Invoke-ModelChatOnce -System $System -User $User
        }
        catch {
            $message = $_.Exception.Message
            $retryable =
                $message -match "returned empty content" -or
                $message -match "HTTP (408|409|425|429|5\d\d)" -or
                $message -match "request failed"
            if (-not $retryable -or $attempt -eq 3) { throw }
            Write-Host ("MODEL RETRY provider={0} attempt={1}" -f $script:ModelProvider, ($attempt + 1))
            Start-Sleep -Seconds ([Math]::Pow(2, $attempt - 1))
        }
    }
}
