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
        $defaultBase = "https://m4.tailf0d018.ts.net/v1"
        $defaultModel = "gemma-4-26b-a4b-it-ultra-uncensored-heretic"
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
    if ($script:ModelProvider -eq "deepseek") {
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
        $request.Timeout = 500000
        $request.ReadWriteTimeout = 500000
        if ($script:ModelAuthMode -eq "bearer") {
            [void]$request.Headers.Add("Authorization", "Bearer " + $script:ModelKey)
        }
        $requestStream = $request.GetRequestStream()
        $requestStream.Write($bytes, 0, $bytes.Length)
        $requestStream.Close()
        $httpResponse = $request.GetResponse()
        $reader = New-Object IO.StreamReader($httpResponse.GetResponseStream(), $script:ModelUtf8NoBom)
        $raw = $reader.ReadToEnd()
        $reader.Close()
        $httpResponse.Close()
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
    try {
        $response = $raw | ConvertFrom-Json
    }
    catch {
        throw ("{0} returned invalid JSON" -f $script:ModelProvider)
    }
    $script:ModelLastFinishReason = [string]$response.choices[0].finish_reason
    $script:ModelLastUsage = $response.usage
    $content = $response.choices[0].message.content
    if ([string]::IsNullOrWhiteSpace($content)) { throw ("{0} returned empty content" -f $script:ModelProvider) }
    return $content.Trim()
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
