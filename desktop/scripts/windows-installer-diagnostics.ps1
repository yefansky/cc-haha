# Dot-sourcing defines helpers only; registry/event access occurs only on explicit calls.
function New-InstallerDiagnostics {
  param([string]$Installer, [string]$Directory)
  return @{ Directory = $Directory; Installer = $Installer; Attempts = @(); Errors = @(); Registry = $null; PrivateDirectory = $null; DumpManifest = @() }
}

function Save-InstallerDiagnostics {
  param($Context)
  try {
    New-Item -ItemType Directory -Path $Context.Directory -Force | Out-Null
    @{ schemaVersion = 1; installerName = [IO.Path]::GetFileName($Context.Installer); attempts = @($Context.Attempts); diagnosticErrors = @($Context.Errors); dumpManifest = @($Context.DumpManifest) } |
      ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Context.Directory 'installer-diagnostics.json') -Encoding UTF8
  } catch { [Console]::Error.WriteLine('Installer diagnostic summary could not be written.') }
}

function Enable-InstallerCrashDumps {
  param($Context)
  # LocalDumps is HKLM-only. Never configure a machine-wide default or enable on a developer workstation.
  if ($env:CI -ne 'true' -or $env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) {
    throw 'Installer crash dumps require an ephemeral GitHub Actions runner.'
  }
  if (-not [IO.Path]::IsPathRooted($env:RUNNER_TEMP) -or -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) { throw 'Missing absolute runner temp directory.' }
  $name = [IO.Path]::GetFileName($Context.Installer)
  if ($name -notmatch '^Claude-Code-Haha-[0-9.]+-win-x64\.exe$') { throw 'Unexpected installer executable name.' }
  $keyPath = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\$name"
  $state = @{ Path = $keyPath; Existed = (Test-Path -LiteralPath $keyPath); Values = @{}; Modified = $false }
  $Context.Registry = $state
  if ($state.Existed) {
    $key = Get-Item -LiteralPath $keyPath
    try {
      foreach ($valueName in @('DumpFolder', 'DumpType', 'DumpCount')) {
        if ($key.GetValueNames() -contains $valueName) {
          $state.Values[$valueName] = @{ Value = $key.GetValue($valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); Kind = [string]$key.GetValueKind($valueName) }
        }
      }
    } finally { $key.Close() }
  }
  $dumpDir = Join-Path ([IO.Path]::GetFullPath($env:RUNNER_TEMP)) ('cc-haha-installer-diagnostics-' + [guid]::NewGuid().ToString('N') + '\private')
  $Context.PrivateDirectory = $dumpDir
  New-Item -ItemType Directory -Path $dumpDir -Force | Out-Null
  $state.Modified = $true
  New-Item -Path $keyPath -Force | Out-Null
  New-ItemProperty -LiteralPath $keyPath -Name DumpFolder -Value $dumpDir -PropertyType ExpandString -Force | Out-Null
  New-ItemProperty -LiteralPath $keyPath -Name DumpType -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -LiteralPath $keyPath -Name DumpCount -Value 2 -PropertyType DWord -Force | Out-Null
}

function Restore-InstallerCrashDumps {
  param($Context)
  $state = $Context.Registry
  if ($null -eq $state -or -not $state.Modified) { return }
  $failed = $false
  foreach ($name in @('DumpFolder', 'DumpType', 'DumpCount')) {
    try {
    if ($state.Values.ContainsKey($name)) {
      $saved = $state.Values[$name]
      New-ItemProperty -LiteralPath $state.Path -Name $name -Value $saved.Value -PropertyType $saved.Kind -Force | Out-Null
    } else {
      $current = Get-Item -LiteralPath $state.Path
      try { $present = $current.GetValueNames() -contains $name } finally { $current.Close() }
      if ($present) { Remove-ItemProperty -LiteralPath $state.Path -Name $name -ErrorAction Stop }
    }
    } catch { $failed = $true }
  }
  if (-not $state.Existed) {
    $key = Get-Item -LiteralPath $state.Path -ErrorAction SilentlyContinue
    if ($null -ne $key) {
      try { $empty = $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0 } finally { $key.Close() }
      if ($empty) { Remove-Item -LiteralPath $state.Path }
    }
  }
  if ($failed) { throw 'Installer dump settings could not all be restored.' }
  $state.Modified = $false
}

function Convert-InstallerFailureEvent {
  param($Event, [string]$Installer, [int]$ProcessId, [datetime]$Started, [datetime]$Ended)
  if ($Event.TimeCreated -lt $Started.AddSeconds(-2) -or $Event.TimeCreated -gt $Ended.AddSeconds(15)) { return }
  if ($Event.Id -notin @(1000, 1001)) { return }
  [xml]$xml = $Event.ToXml()
  $data = @{}
  foreach ($entry in $xml.Event.EventData.Data) { $data[[string]$entry.Name] = [string]$entry.'#text' }
  $name = [IO.Path]::GetFileName($Installer)
  if ($Event.Id -eq 1000) {
    if ($Event.ProviderName -ne 'Application Error' -or $data.AppName -ne $name) { return }
    $eventPid = 0L
    try {
      $eventPid = if ($data.ProcessId -match '^0x') { [Convert]::ToInt64($data.ProcessId.Substring(2), 16) } else { [long]$data.ProcessId }
    } catch { return }
    if ($eventPid -ne $ProcessId -or ($data.AppPath -and $data.AppPath -ne $Installer)) { return }
    return @{ eventId = 1000; timeUtc = $Event.TimeCreated.ToUniversalTime().ToString('o'); correlation = 'name_path_pid_time'; processId = $eventPid; appName = $name; moduleName = [IO.Path]::GetFileName($data.ModuleName); modulePath = (Convert-InstallerModulePath $data.ModulePath); exceptionCode = (Convert-InstallerHex $data.ExceptionCode); faultOffset = (Convert-InstallerHex $data.FaultingOffset) }
  }
  if ($Event.ProviderName -ne 'Windows Error Reporting' -or $data.P1 -ne $name) { return }
  # WER 1001 commonly has no faulting PID. Do not mislabel its provider process ID as the application PID.
  if ($data.EventName -notin @('APPCRASH', 'BEX', 'BEX64')) { return }
  $result = @{ eventId = 1001; timeUtc = $Event.TimeCreated.ToUniversalTime().ToString('o'); correlation = 'name_time_only'; eventName = $data.EventName }
  if ($data.EventName -eq 'APPCRASH') {
    $result.moduleName = [IO.Path]::GetFileName($data.P4)
    $result.exceptionCode = Convert-InstallerHex $data.P7
    $result.faultOffset = Convert-InstallerHex $data.P8
  }
  return $result
}

function Convert-InstallerHex {
  param([string]$Value)
  if ($Value -match '^(0x)?[0-9a-fA-F]{1,16}$') { return $Value }
  return $null
}

function Convert-InstallerModulePath {
  param([string]$Value)
  if ($Value -match '^[A-Za-z]:\\Windows\\(System32|SysWOW64)\\[^\\]+$') { return $Value }
  if ($Value) { return '<non-system>\' + [IO.Path]::GetFileName($Value) }
  return $null
}

function Complete-InstallerDiagnostics {
  param($Context)
  try { Restore-InstallerCrashDumps -Context $Context } catch { $Context.Errors += 'dump_settings_restore_failed' }
  if ($Context.PrivateDirectory) {
    try {
      $name = [IO.Path]::GetFileName($Context.Installer)
      foreach ($file in @(Get-ChildItem -LiteralPath $Context.PrivateDirectory -File -Filter '*.dmp')) {
        foreach ($attempt in $Context.Attempts) {
          if ($file.Name -eq "$name.$($attempt.processId).dmp" -and $file.LastWriteTimeUtc -ge ([datetime]$attempt.startedUtc).ToUniversalTime().AddSeconds(-2) -and $file.LastWriteTimeUtc -le ([datetime]$attempt.endedUtc).ToUniversalTime().AddSeconds(15)) {
            $Context.DumpManifest += @{ name = $file.Name; size = $file.Length; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
          }
        }
      }
    } catch { $Context.Errors += 'dump_manifest_failed' }
  }
  # Raw dumps remain exclusively in the ephemeral runner's private temp directory.
  Save-InstallerDiagnostics -Context $Context
}

function Add-InstallerFailureDiagnostics {
  param($Context, [string]$Stage, [int]$ProcessId, [datetime]$Started, [datetime]$Ended, [int]$ExitCode)
  $attempt = @{ stage = $Stage; processId = $ProcessId; startedUtc = $Started.ToUniversalTime().ToString('o'); endedUtc = $Ended.ToUniversalTime().ToString('o'); exitCode = $ExitCode; exitHex = ('0x{0:X8}' -f [BitConverter]::ToUInt32([BitConverter]::GetBytes($ExitCode), 0)); events = @() }
  $Context.Attempts += $attempt
  try {
    # Event-log ingestion can lag process termination. Bounded wait only on failed installer invocations.
    Start-Sleep -Seconds 3
    $records = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = @(1000,1001); StartTime = $Started.AddSeconds(-2); EndTime = $Ended.AddSeconds(15) } -ErrorAction Stop)
    foreach ($record in $records) {
      $projected = Convert-InstallerFailureEvent -Event $record -Installer $Context.Installer -ProcessId $ProcessId -Started $Started -Ended $Ended
      if ($null -ne $projected) { $attempt.events += $projected }
    }
  } catch {
    if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { $Context.Errors += 'event_collection_failed' }
  }
  Save-InstallerDiagnostics -Context $Context
}
