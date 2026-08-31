# Harness: safe -> draft -> check -> rewrite
# Prompts live in harness/. PowerShell 5.x.
#   powershell -NoProfile -File .cursor/skills/fit-letters/scripts/harness-4step.ps1 -Person X -N 33 -Root "..."

param(
    [Parameter(Mandatory = $true)][string]$Person,
    [Parameter(Mandatory = $true)][int]$N,
    [string]$Root = "",
    [string]$RulesFile = "",
    [string]$HarnessDir = "",
    [string]$Tag = "",
    [string]$Model = "",
    [string]$ReuseSafeTag = "",
    [string]$ArchivePath = "",
    [string]$OutFile = "",
    [string]$DraftFile = "",
    [string]$PrecheckFile = "",
    [string]$HistoryFile = "",
    [string]$PreviousStateTag = "",
    [string]$PreviousReplyOverrideFile = "",
    [switch]$NoThink,
    [switch]$InitializeState,
    [switch]$AllowStateBootstrap,
    [switch]$StopAfterSafe,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = (Get-Location).Path }
. (Join-Path $PSScriptRoot "memory-lib.ps1")
. (Join-Path $PSScriptRoot "history-retrieval.ps1")
Initialize-Ds -Root $Root
if (-not [string]::IsNullOrWhiteSpace($Model)) { Set-DsModel -Model $Model }
if ($NoThink) { Set-DsThinking -On $false }
$sw = [Diagnostics.Stopwatch]::StartNew()
function Say([string]$m) {
    if ($Quiet) { Write-Output $m }
    else { Write-Output $m }
}
function Lap([string]$step) {
    if (-not $Quiet) { Write-Output ("{0} {1}s" -f $step, [int]$sw.Elapsed.TotalSeconds) }
}

$nn = "{0:D2}" -f $N
$probe = Join-Path $Root "_probe"
if (-not (Test-Path -LiteralPath $probe)) { New-Item -ItemType Directory -Path $probe | Out-Null }
$suffix = ""
if (-not [string]::IsNullOrWhiteSpace($Tag)) { $suffix = "_" + $Tag }
function Save-Step([string]$step, [string]$text) {
    $p = Join-Path $probe ("h4_{0}_{1}{2}_{3}.txt" -f $Person, $nn, $suffix, $step)
    Write-Utf8 $p $text
    if ($step -eq "5final" -and -not [string]::IsNullOrWhiteSpace($OutFile)) { Write-Utf8 $OutFile $text }
    if (-not $Quiet) { Write-Output ("wrote " + $p) }
}

if ([string]::IsNullOrWhiteSpace($HarnessDir)) { $HarnessDir = Join-Path $Root "harness" }
if (-not [IO.Path]::IsPathRooted($HarnessDir)) { $HarnessDir = Join-Path $Root $HarnessDir }

function Expand-Harness([string]$text, [hashtable]$map) {
    $out = $text
    foreach ($k in $map.Keys) {
        $out = $out.Replace(("{{" + $k + "}}"), [string]$map[$k])
    }
    return $out
}

function Get-HarnessPrompt([string]$fileName) {
    $path = Join-Path $HarnessDir $fileName
    if (-not (Test-Path -LiteralPath $path)) { throw ("missing harness prompt: " + $path) }
    $raw = Read-Utf8 $path
    $sysMarker = "## System"
    $userMarker = "## User"
    $iSys = $raw.IndexOf($sysMarker)
    $iUser = $raw.IndexOf($userMarker)
    if ($iSys -lt 0 -or $iUser -lt 0 -or $iUser -le $iSys) {
        throw ("harness prompt need ## System and ## User: " + $path)
    }
    $sys = $raw.Substring($iSys + $sysMarker.Length, $iUser - $iSys - $sysMarker.Length).Trim()
    $user = $raw.Substring($iUser + $userMarker.Length).Trim()
    return @{ System = $sys; User = $user }
}

$writeHeading = "# " + (-join @([char]0x5199, [char]0x6CD5))
$personaHeading = "## " + (-join @([char]0x57FA, [char]0x7840))
if ([string]::IsNullOrWhiteSpace($RulesFile)) { $RulesFile = Join-Path $Root ".cursor\rules\linli-letters.mdc" }
if (-not [IO.Path]::IsPathRooted($RulesFile)) { $RulesFile = Join-Path $Root $RulesFile }
$personaPath = Join-Path $Root ((-join @([char]0x6797, [char]0x79BB, [char]0x4EBA, [char]0x8BBE)) + ".md")
$archDir = -join @([char]0x4FE1, [char]0x4EF6, [char]0x5F80, [char]0x6765)
$rules = Take-FromHeading (Strip-Yaml (Read-Utf8 $RulesFile)) $writeHeading
$persona = Take-FromHeading (Read-Utf8 $personaPath) $personaHeading
$fields = (Read-Utf8 (Join-Path $HarnessDir ("00-" + (-join @([char]0x680F, [char]0x76EE)) + ".md"))).Trim()

Write-Output ("STEP0 memory " + $Person + " " + $nn)
$arch = Join-Path $Root ("{0}\{1}.md" -f $archDir, $Person)
if (-not [string]::IsNullOrWhiteSpace($ArchivePath)) { $arch = $ArchivePath }
$openingPath = Join-Path $HarnessDir ((-join @([char]0x5F00, [char]0x4FE1)) + ".md")
if (-not (Test-Path -LiteralPath $openingPath)) { $openingPath = Join-Path $Root ("harness\" + (-join @([char]0x5F00, [char]0x4FE1)) + ".md") }
$ctx = Build-Memory -Root $Root -Person $Person -N $N -ArchivePath $arch -OpeningPath $openingPath
$factCtx = Build-FactMemory -Root $Root -Person $Person -N $N -ArchivePath $arch -OpeningPath $openingPath
if ([string]::IsNullOrWhiteSpace($HistoryFile)) {
    $historySnapshot = New-HistorySnapshotFromArchive -ArchivePath $arch -Person $Person -BeforeN $N
}
else {
    if (-not [IO.Path]::IsPathRooted($HistoryFile)) { $HistoryFile = Join-Path $Root $HistoryFile }
    $historySnapshot = Read-HistorySnapshot -Path $HistoryFile
    if ([string]$historySnapshot.person -ne $Person) { throw "history snapshot person mismatch" }
}
if (-not [string]::IsNullOrWhiteSpace($PreviousReplyOverrideFile)) {
    if ($N -lt 2) { throw "previous reply override requires N >= 2" }
    if (-not [IO.Path]::IsPathRooted($PreviousReplyOverrideFile)) { $PreviousReplyOverrideFile = Join-Path $Root $PreviousReplyOverrideFile }
    if (-not (Test-Path -LiteralPath $PreviousReplyOverrideFile)) { throw ("previous reply override not found: " + $PreviousReplyOverrideFile) }
    $overrideReply = (Read-Utf8 $PreviousReplyOverrideFile).Trim()
    $linliHeading = "#### " + (-join @([char]0x6797, [char]0x79BB))
    $targetHeading = "## " + (-join @([char]0x8981, [char]0x56DE, [char]0x7684, [char]0x6765, [char]0x4FE1))
    $replyHeadingStart = $ctx.LastIndexOf($linliHeading)
    $targetHeadingStart = $ctx.IndexOf($targetHeading, $replyHeadingStart)
    if ($replyHeadingStart -lt 0 -or $targetHeadingStart -lt 0) { throw "cannot locate previous reply in memory context" }
    $replyHeadingEnd = $ctx.IndexOf("`n", $replyHeadingStart)
    if ($replyHeadingEnd -lt 0 -or $replyHeadingEnd -ge $targetHeadingStart) { throw "cannot locate previous reply heading end" }
    $ctx = $ctx.Substring(0, $replyHeadingEnd + 1) + "`n" + $overrideReply + "`n`n" + $ctx.Substring($targetHeadingStart)
    $replyHeadingStart = $factCtx.LastIndexOf($linliHeading)
    $targetHeadingStart = $factCtx.IndexOf($targetHeading, $replyHeadingStart)
    if ($replyHeadingStart -lt 0 -or $targetHeadingStart -lt 0) { throw "cannot locate previous reply in fact context" }
    $replyHeadingEnd = $factCtx.IndexOf("`n", $replyHeadingStart)
    if ($replyHeadingEnd -lt 0 -or $replyHeadingEnd -ge $targetHeadingStart) { throw "cannot locate previous reply heading end in fact context" }
    $factCtx = $factCtx.Substring(0, $replyHeadingEnd + 1) + "`n" + $overrideReply + "`n`n" + $factCtx.Substring($targetHeadingStart)
}

$relationshipLabel = -join @([char]0x4F60, [char]0x4EEC, [char]0x7684, [char]0x5173, [char]0x7CFB)
$progressLabel = -join @([char]0x4F60, [char]0x4EEC, [char]0x5173, [char]0x7CFB, [char]0x8FDB, [char]0x5C55, [char]0x7684, [char]0x5173, [char]0x952E, [char]0x70B9)
$relationshipMemoryLines = @(
    ($ctx -split "`r?`n") |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_.StartsWith($relationshipLabel) -or $_.StartsWith($progressLabel) }
)
$relationshipMemory = "无"
if ($relationshipMemoryLines.Count -gt 0) { $relationshipMemory = [string]::Join("`n", $relationshipMemoryLines) }

$stateBootstrapRequired = $InitializeState
$previousState = "无（未启用上一轮状态传递）"
if (-not [string]::IsNullOrWhiteSpace($PreviousStateTag)) {
    if ($N -eq 1) {
        $previousState = "无（首封，无上一轮状态）"
        $stateBootstrapRequired = $true
    }
    else {
        $previousNn = "{0:D2}" -f ($N - 1)
        $previousStatePath = Join-Path $probe ("h4_{0}_{1}_{2}_1safe.txt" -f $Person, $previousNn, $PreviousStateTag)
        if (-not (Test-Path -LiteralPath $previousStatePath)) {
            if (-not $AllowStateBootstrap) { throw ("missing previous state: " + $previousStatePath) }
            $previousState = "无（缺少前置账本；依据全部可见历史初始化）"
            $stateBootstrapRequired = $true
        }
        else {
            $previousSafeLines = @(
                ((Read-Utf8 $previousStatePath) -split "`r?`n") |
                    ForEach-Object { $_.Trim() } |
                    Where-Object { $_.Length -gt 0 }
            )
            $statePrefixes = @("关系　", "关系依据　", "已承认情感　", "已承认称呼　", "既有亲密　", "既有边界　", "亲密上限　")
            $stateLines = @(
                $previousSafeLines |
                    Where-Object {
                        $line = $_
                        @($statePrefixes | Where-Object { $line.StartsWith($_) }).Count -gt 0
                    }
            )
            if ($stateLines.Count -lt 4) { throw ("invalid previous state: " + $previousStatePath) }
            $previousState = [string]::Join("`n", $stateLines)
        }
    }
}

# STEP1: safety gate (was writing card)
$precheckPrompt = "01-" + (-join @([char]0x9884, [char]0x68C0)) + ".md"
if ($stateBootstrapRequired) {
    $precheckPrompt = "01-" + (-join @([char]0x521D, [char]0x59CB, [char]0x5316, [char]0x8D26, [char]0x672C)) + ".md"
}
if (-not [string]::IsNullOrWhiteSpace($PrecheckFile)) { $precheckPrompt = $PrecheckFile }
$p1 = Get-HarnessPrompt $precheckPrompt
if ([string]::IsNullOrWhiteSpace($ReuseSafeTag)) {
    $map1 = @{ ctx = $ctx; rules = $rules; previousState = $previousState; relationshipMemory = $relationshipMemory }
    $sysSafe = Expand-Harness $p1.System $map1
    $userSafe = Expand-Harness $p1.User $map1
    Write-Output ("STEP1 safe " + $Person + " " + $nn)
    $safe = Invoke-Ds -System $sysSafe -User $userSafe
}
else {
    $reuseSafePath = Join-Path $probe ("h4_{0}_{1}_{2}_1safe.txt" -f $Person, $nn, $ReuseSafeTag)
    if (-not (Test-Path -LiteralPath $reuseSafePath)) { throw ("missing reused precheck: " + $reuseSafePath) }
    Write-Output ("STEP1 reuse-safe " + $Person + " " + $nn + " from=" + $ReuseSafeTag)
    $safe = Read-Utf8 $reuseSafePath
}
Save-Step "1safe" $safe
Lap "T1safe"

$expectedSafeLines = 8
if ($p1.System -match "九行") { $expectedSafeLines = 9 }
if ($p1.System -match "十三行") { $expectedSafeLines = 13 }
if ($p1.System -match "十四行") { $expectedSafeLines = 14 }
$safeLines = @(($safe -split "`r?`n") | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
$fullWidthSpace = [string][char]0x3000
$conclusionWord = -join @([char]0x7ED3, [char]0x8BBA)
$allowedRelationships = @()
if ($expectedSafeLines -ge 13) {
    $relationshipWord = -join @([char]0x5173, [char]0x7CFB)
    $relationshipDefinition = @(
        ($p1.System -split "`r?`n") |
            Where-Object { $_.StartsWith($relationshipWord + $fullWidthSpace) }
    )[0]
    $allowedRelationships = @(
        $relationshipDefinition.Substring($relationshipDefinition.IndexOf($fullWidthSpace) + 1) -split ([string][char]0xFF0F)
    )
}
function Test-SafeLedgerFormat([string]$Text, [int]$ExpectedLines, $Relationships) {
    $lines = @(($Text -split "`r?`n") | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
    if ($lines.Count -ne $ExpectedLines) { return $false }
    if (@($lines | Where-Object { $_.IndexOf($fullWidthSpace) -lt 1 }).Count -gt 0) { return $false }
    if (-not $lines[$ExpectedLines - 1].StartsWith($conclusionWord)) { return $false }
    if ($Text -match "(?m)^\s*(#|---)") { return $false }
    if ($ExpectedLines -ge 13) {
        $relationshipValue = $lines[4].Substring($lines[4].IndexOf($fullWidthSpace) + 1).Trim()
        if (-not ($Relationships -contains $relationshipValue)) { return $false }
    }
    return $true
}
$invalidSafe = -not (Test-SafeLedgerFormat -Text $safe -ExpectedLines $expectedSafeLines -Relationships $allowedRelationships)
if ($invalidSafe -and [string]::IsNullOrWhiteSpace($ReuseSafeTag)) {
    Write-Output ("STEP1 repair-format " + $Person + " " + $nn)
    $repairSystem = $p1.System + "`n`n上一版输出格式不合格。重新执行原任务，字段不可省略；只输出规定行数与规定字段，不要解释。"
    $repairUser = $userSafe + "`n`n格式不合格的上一版输出：`n" + $safe
    $safe = Invoke-Ds -System $repairSystem -User $repairUser
    Save-Step "1safe" $safe
    $safeLines = @(($safe -split "`r?`n") | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
    $invalidSafe = -not (Test-SafeLedgerFormat -Text $safe -ExpectedLines $expectedSafeLines -Relationships $allowedRelationships)
}
if ($invalidSafe) { throw "STEP1 precheck format invalid" }

if ($StopAfterSafe) {
    Write-Output ("HARNESS1 DONE {0} {1}{2} total={3}s" -f $Person, $nn, $suffix, [int]$sw.Elapsed.TotalSeconds)
    return
}

$blockWord = -join @([char]0x62E6, [char]0x622A)
if ($safe -match $blockWord) {
    Save-Step "5final" ("[BLOCKED]`n" + $safe)
    Write-Output ("STEP1 blocked " + $Person + " " + $nn)
    Write-Output ("HARNESS5 DONE {0} {1}{2} total={3}s blocked=1" -f $Person, $nn, $suffix, [int]$sw.Elapsed.TotalSeconds)
    return
}

$historyBudget = New-HistoryBudget
$historyResults = @()
$historyEvidence = @()
$historyAudit = @()
$historyTermination = "planner-finished"
$historyPrompt = Get-HarnessPrompt ("02-" + (-join @([char]0x5386, [char]0x53F2, [char]0x68C0, [char]0x7D22)) + ".md")
$historyPlannerThinking = $script:DsThinking
Set-DsThinking -On $false
$historicalProofRequired = $safe -match "(?m)^事实伪造　有　.*(往来|旧信|上封|以前|之前|曾经|叫过|写过|说过|记得)"
for ($historyRound = 1; $historyRound -le 2; $historyRound++) {
    $remainingSeconds = [Math]::Max(0, 45 - [int](([DateTime]::UtcNow - $historyBudget.startedAt).TotalSeconds))
    $budgetText = "轮次 $historyRound/2；查询 $($historyBudget.queryCount)/4；完整往来 $($historyBudget.fullReads)/3；字符 $($historyBudget.characters)/12000；时间剩余 ${remainingSeconds}s"
    $resultText = "无（尚未检索）"
    if ($historyResults.Count -gt 0) { $resultText = $historyResults | ConvertTo-Json -Depth 8 }
    $historyMap = @{
        safe = $safe
        navigation = $ctx
        facts = $factCtx
        historyResults = $resultText
        budget = $budgetText
    }
    Write-Output ("STEP2 history-plan round=" + $historyRound + " " + $Person + " " + $nn)
    $intent = Invoke-DsJson `
        -System (Expand-Harness $historyPrompt.System $historyMap) `
        -User (Expand-Harness $historyPrompt.User $historyMap)
    $historyAudit += [pscustomobject]([ordered]@{
        round = $historyRound
        intent = $intent
        finishReason = $script:DsLastFinishReason
        usage = $script:DsLastUsage
    })
    Save-Step ("2history_{0}_intent" -f $historyRound) ($intent | ConvertTo-Json -Depth 8)
    $hasCandidates = @($historyResults | Where-Object { $_.kind -eq "candidate" }).Count -gt 0
    if ([string]$intent.action -eq "finish" -and $historyEvidence.Count -eq 0 -and ($hasCandidates -or $historicalProofRequired)) {
        $repairContext = if ($hasCandidates) { $resultText } else { "无候选；请先 search，或按暂定账本指出的往来顺序直接 read。" }
        $finishRepairMap = @{
            safe = $safe
            navigation = $ctx
            facts = $factCtx
            historyResults = "暂定账本正在判断一项历史真伪，当前来信自己的引文不是证据，你尚未取得完整历史原文，不能 finish。必须 read 或 neighbors；没有候选时先 search，或按账本指出的往来顺序直接 read。`n" + $repairContext
            budget = $budgetText
        }
        $intent = Invoke-DsJson `
            -System (Expand-Harness $historyPrompt.System $finishRepairMap) `
            -User (Expand-Harness $historyPrompt.User $finishRepairMap)
        $historyAudit += [pscustomobject]([ordered]@{
            round = $historyRound
            contractRepair = "historical claim requires original evidence"
            repairedIntent = $intent
            finishReason = $script:DsLastFinishReason
            usage = $script:DsLastUsage
        })
        Save-Step ("2history_{0}_intent_repaired" -f $historyRound) ($intent | ConvertTo-Json -Depth 8)
    }
    if ([string]$intent.action -eq "finish") {
        if ($historyEvidence.Count -eq 0 -and $historicalProofRequired) {
            throw "history evidence required but planner did not retrieve original text"
        }
        $historyTermination = "planner-finished: " + [string]$intent.reason
        break
    }
    if ([string]$intent.action -in @("search", "read", "neighbors") -and @($intent.lookups).Count -gt 0) {
        $historyAudit += [pscustomobject]([ordered]@{
            round = $historyRound
            formatRepair = "normalized top-level action to lookup"
        })
        $intent.action = "lookup"
    }
    if ([string]$intent.action -ne "lookup") {
        $historyTermination = "invalid-action"
        break
    }
    try {
        $retrieved = Invoke-HistoryRetrieval -Snapshot $historySnapshot -Intent $intent -Budget $historyBudget
    }
    catch {
        $rejection = $_.Exception.Message
        $historyAudit += [pscustomobject]([ordered]@{
            round = $historyRound
            rejection = $rejection
        })
        if ($rejection -match "time budget exceeded") {
            $historyTermination = "retrieval-frozen: " + $rejection
            break
        }
        $repairMap = @{
            safe = $safe
            navigation = $ctx
            facts = $factCtx
            historyResults = "档案室拒绝上一请求：$rejection。只修复一次；若不能合法检索请 finish。"
            budget = $budgetText
        }
        try {
            $intent = Invoke-DsJson `
                -System (Expand-Harness $historyPrompt.System $repairMap) `
                -User (Expand-Harness $historyPrompt.User $repairMap)
            if ([string]$intent.action -eq "finish") {
                $historyTermination = "planner-finished-after-repair: " + [string]$intent.reason
                break
            }
            if ([string]$intent.action -ne "lookup") { throw "history repaired action invalid" }
            $retrieved = Invoke-HistoryRetrieval -Snapshot $historySnapshot -Intent $intent -Budget $historyBudget
        }
        catch {
            $historyTermination = "retrieval-frozen: " + $_.Exception.Message
            break
        }
    }
    $historyResults += @($retrieved.candidates)
    $historyResults += @($retrieved.evidence)
    $knownEvidence = @{}
    foreach ($item in $historyEvidence) { $knownEvidence[[string]$item.letterId] = $true }
    foreach ($item in @($retrieved.evidence)) {
        if (-not $knownEvidence.ContainsKey([string]$item.letterId)) {
            $historyEvidence += $item
            $knownEvidence[[string]$item.letterId] = $true
        }
    }
    Save-Step ("2history_{0}_result" -f $historyRound) ($retrieved | ConvertTo-Json -Depth 8)
    if ($historyRound -eq 2) { $historyTermination = "round-budget-exhausted" }
}
Set-DsThinking -On $historyPlannerThinking
$historyRetrievalElapsedMs = [int](([DateTime]::UtcNow - $historyBudget.startedAt).TotalMilliseconds)

$evidenceText = "无（本轮不需要检索历史原文）"
$reconcileAudit = $null
if ($historyEvidence.Count -gt 0) {
    $reconcileStartedAt = [DateTime]::UtcNow
    $evidenceText = $historyEvidence | ConvertTo-Json -Depth 8
    $provisionalSafe = $safe
    Save-Step "1safe_provisional" $provisionalSafe
    $reconcilePrompt = Get-HarnessPrompt ("02-" + (-join @([char]0x8D26, [char]0x672C, [char]0x6821, [char]0x6B63)) + ".md")
    $reconcileMap = @{ safe = $provisionalSafe; facts = $factCtx; evidence = $evidenceText }
    Write-Output ("STEP2 reconcile " + $Person + " " + $nn)
    Set-DsThinking -On $false
    $safe = Invoke-Ds `
        -System (Expand-Harness $reconcilePrompt.System $reconcileMap) `
        -User (Expand-Harness $reconcilePrompt.User $reconcileMap)
    Save-Step "1safe_reconcile_attempt1" $safe
    $reconcileCalls = 1
    $reconcileUsage = @($script:DsLastUsage)
    $reconcileInvalid = -not (Test-SafeLedgerFormat -Text $safe -ExpectedLines 14 -Relationships $allowedRelationships)
    if ($safe -match "(?m)^(关系依据|已承认称呼|既有亲密|既有边界)　.*(五段式|摘要|回忆)") { $reconcileInvalid = $true }
    if ($reconcileInvalid) {
        $reconcileSystem = $reconcilePrompt.System + "`n`n上一版格式或证据来源不合格。只输出规定十四行，字段不可省略；最终账本不得把五段式、摘要或回忆写成事实依据，改引近期原文或检索原文的往来顺序/letterId。"
        $safe = Invoke-Ds -System (Expand-Harness $reconcileSystem $reconcileMap) -User (Expand-Harness $reconcilePrompt.User $reconcileMap)
        Save-Step "1safe_reconcile_attempt2" $safe
        $reconcileCalls += 1
        $reconcileUsage += $script:DsLastUsage
    }
    $reconcileInvalid = -not (Test-SafeLedgerFormat -Text $safe -ExpectedLines 14 -Relationships $allowedRelationships)
    if ($safe -match "(?m)^(关系依据|已承认称呼|既有亲密|既有边界)　.*(五段式|摘要|回忆)") { $reconcileInvalid = $true }
    if ($reconcileInvalid) {
        throw "STEP2 reconciled ledger format invalid"
    }
    Set-DsThinking -On $historyPlannerThinking
    $reconcileAudit = [ordered]@{
        calls = $reconcileCalls
        finishReason = $script:DsLastFinishReason
        usage = $reconcileUsage
        elapsedMs = [int](([DateTime]::UtcNow - $reconcileStartedAt).TotalMilliseconds)
    }
    Save-Step "1safe" $safe
}

$historyAuditPackage = [ordered]@{
    schema = "olivia-history.audit"
    version = 1
    snapshot = [ordered]@{
        snapshotId = [string]$historySnapshot.snapshotId
        person = [string]$historySnapshot.person
        maxOrder = [int]$historySnapshot.maxOrder
    }
    planner = $historyAudit
    reconcile = $reconcileAudit
    retrievalResults = $historyResults
    evidence = $historyEvidence
    budget = [ordered]@{
        queries = [int]$historyBudget.queryCount
        fullReads = [int]$historyBudget.fullReads
        characters = [int]$historyBudget.characters
        elapsedMs = $historyRetrievalElapsedMs
    }
    totalElapsedMs = [int](([DateTime]::UtcNow - $historyBudget.startedAt).TotalMilliseconds)
    terminationReason = $historyTermination
}
Save-Step "2history_audit" ($historyAuditPackage | ConvertTo-Json -Depth 10)
Lap "T2history"

if ([string]::IsNullOrWhiteSpace($DraftFile)) {
    $p3 = Get-HarnessPrompt ("03-" + (-join @([char]0x4E2D, [char]0x6BB5, [char]0x751F, [char]0x6210)) + ".md")
    $map3 = @{ fields = $fields; safe = $safe; rules = $rules; persona = $persona; ctx = $factCtx; evidence = $evidenceText }
    $sysDraft = Expand-Harness $p3.System $map3
    $userDraft = Expand-Harness $p3.User $map3
    Write-Output ("STEP3 draft " + $Person + " " + $nn)
    $draft = Invoke-Ds -System $sysDraft -User $userDraft
}
else {
    if (-not [IO.Path]::IsPathRooted($DraftFile)) { $DraftFile = Join-Path $Root $DraftFile }
    if (-not (Test-Path -LiteralPath $DraftFile)) { throw ("draft file not found: " + $DraftFile) }
    Write-Output ("STEP3 reuse-draft " + $Person + " " + $nn)
    $draft = Read-Utf8 $DraftFile
}
Save-Step "3draft" $draft
Lap "T3draft"

$p4 = Get-HarnessPrompt ("04-" + (-join @([char]0x5C3E, [char]0x7AEF, [char]0x68C0, [char]0x67E5)) + ".md")
$map4 = @{ fields = $fields; safe = $safe; persona = $persona; draft = $draft; ctx = $factCtx; evidence = $evidenceText }
$sysCheck = Expand-Harness $p4.System $map4
$userCheck = Expand-Harness $p4.User $map4
Write-Output ("STEP4 check " + $Person + " " + $nn)
$check = Invoke-Ds -System $sysCheck -User $userCheck
Save-Step "4check" $check
Lap "T4check"

$badWord = -join @([char]0x8FDD, [char]0x89C4)
$fullWidthSpace = [string][char]0x3000
$bad = @(
    foreach ($line in ($check -split "`n")) {
        $parts = @($line.Trim() -split [regex]::Escape($fullWidthSpace))
        if ($parts.Count -ge 2 -and $parts[1].Trim() -eq $badWord) { $line }
    }
)
if ($bad.Count -eq 0) {
    Save-Step "5final" $draft
    Write-Output ("STEP5 clean " + $Person + " " + $nn)
}
else {
    $check = [string]::Join("`n", $bad)
    $p5 = Get-HarnessPrompt ("05-" + (-join @([char]0x53CD, [char]0x9988, [char]0x91CD, [char]0x5199)) + ".md")
    $map5 = @{ fields = $fields; safe = $safe; check = $check; rules = $rules; persona = $persona; draft = $draft; ctx = $factCtx; evidence = $evidenceText }
    $sysFix = Expand-Harness $p5.System $map5
    $userFix = Expand-Harness $p5.User $map5
    Write-Output ("STEP5 rewrite " + $Person + " " + $nn)
    $final = Invoke-Ds -System $sysFix -User $userFix
    Save-Step "5rewrite" $final
    $recheckMap = @{ fields = $fields; safe = $safe; persona = $persona; draft = $final; ctx = $factCtx; evidence = $evidenceText }
    Write-Output ("STEP5 recheck " + $Person + " " + $nn)
    $recheck = Invoke-Ds `
        -System (Expand-Harness $p4.System $recheckMap) `
        -User (Expand-Harness $p4.User $recheckMap)
    Save-Step "5recheck" $recheck
    $recheckBad = @(
        foreach ($line in ($recheck -split "`n")) {
            $parts = @($line.Trim() -split [regex]::Escape($fullWidthSpace))
            if ($parts.Count -ge 2 -and $parts[1].Trim() -eq $badWord) { $line }
        }
    )
    if ($recheckBad.Count -gt 0) { throw "STEP5 rewritten reply still violates hard checks" }
    Save-Step "5final" $final
}

Write-Output ("HARNESS5 DONE {0} {1}{2} total={3}s" -f $Person, $nn, $suffix, [int]$sw.Elapsed.TotalSeconds)
