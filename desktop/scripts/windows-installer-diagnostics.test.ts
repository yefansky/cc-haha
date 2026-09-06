import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const helper = path.join(import.meta.dirname, 'windows-installer-diagnostics.ps1')
const smoke = path.join(import.meta.dirname, 'windows-installer-smoke.ps1')
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

function run(body: string) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'installer-diagnostics-test-'))
  try {
    const code = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Set-StrictMode -Version Latest
. ${quote(helper)}
$fixtureRoot=${quote(temp)}
function Assert($ok, $message) { if (-not $ok) { throw $message } }
${body}
Write-Output 'fixture passed'
`
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30_000 })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('fixture passed')
  } finally { rmSync(temp, { recursive: true, force: true }) }
}

const fakeRegistry = `
$script:values=@{DumpFolder='%OLD%\\Dumps'; DumpType=2; Unrelated='keep'}
$script:kinds=@{DumpFolder='ExpandString';DumpType='DWord';Unrelated='String'}
$script:keyExisted=$true
$script:keyPath=''
$script:failProperty=''
function Test-Path { param($LiteralPath,$PathType) if ($LiteralPath -like 'HKLM:*') { return $script:keyExisted }; return (Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath) }
function New-Item { param($Path,$ItemType,[switch]$Force) if ($Path -like 'HKLM:*') { $script:keyPath=$Path; $script:keyExisted=$true; return }; Microsoft.PowerShell.Management\\New-Item -Path $Path -ItemType $ItemType -Force:$Force }
function Get-Item {
 param($LiteralPath,$ErrorAction)
 Assert ($LiteralPath -like 'HKLM:*') 'unexpected registry read'
 $item=[pscustomobject]@{ValueCount=$script:values.Count;SubKeyCount=0}
 $item | Add-Member ScriptMethod GetValueNames { return @($script:values.Keys) }
 $item | Add-Member ScriptMethod GetValue { param($name,$fallback,$options); return $script:values[$name] }
 $item | Add-Member ScriptMethod GetValueKind { param($name);return $script:kinds[$name] }
 $item | Add-Member ScriptMethod Close {}
 return $item
}
function New-ItemProperty { param($LiteralPath,$Name,$Value,$PropertyType,[switch]$Force) if ($Name -eq $script:failProperty) { throw 'fixture write failure' };$script:values[$Name]=$Value;$script:kinds[$Name]=$PropertyType }
function Remove-ItemProperty { param($LiteralPath,$Name,$ErrorAction) $script:values.Remove($Name);$script:kinds.Remove($Name) }
function Remove-Item { param($LiteralPath) Assert ($LiteralPath -eq $script:keyPath) 'delete escaped exact registry key';$script:keyExisted=$false }
$env:CI='true';$env:GITHUB_ACTIONS='true';$env:RUNNER_TEMP=$fixtureRoot
$ctx=New-InstallerDiagnostics -Installer 'C:\\build\\Claude-Code-Haha-0.6.37-win-x64.exe' -Directory (Join-Path $fixtureRoot 'public')
`

describe.skipIf(process.platform !== 'win32')('Windows installer diagnostics (no installation or real registry access)', () => {
  it('parses both scripts without executing the installer', () => run(`
foreach ($file in @(${quote(helper)},${quote(smoke)})) {
 $errors=$null;$tokens=$null
 [void][Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
 Assert ($errors.Count -eq 0) 'PowerShell syntax error'
}`))

  it('restores existing registry value types and preserves unrelated values after enabling', () => run(fakeRegistry + `
Enable-InstallerCrashDumps $ctx
Assert ($script:values.DumpType -eq 1 -and $script:values.DumpCount -eq 2) 'minidump configuration missing'
Assert ($script:values.DumpFolder.StartsWith($fixtureRoot) -and $script:values.DumpFolder.EndsWith('\\private')) 'raw dump outside private runner temp'
Assert ($script:keyPath.EndsWith('LocalDumps\\Claude-Code-Haha-0.6.37-win-x64.exe')) 'not exact executable key'
Restore-InstallerCrashDumps $ctx
Assert ($script:values.DumpFolder -eq '%OLD%\\Dumps' -and $script:kinds.DumpFolder -eq 'ExpandString') 'lost unexpanded backup/type'
Assert ($script:values.DumpType -eq 2 -and -not $script:values.ContainsKey('DumpCount')) 'restore missing values failed'
Assert ($script:values.Unrelated -eq 'keep') 'unrelated registry state changed'
`))

  it('restores a partially configured key and continues other restores after one fails', () => run(fakeRegistry + `
$script:failProperty='DumpType'
try { Enable-InstallerCrashDumps $ctx } catch {}
Assert $ctx.Registry.Modified 'partial setup must be recoverable'
$script:failProperty='DumpFolder'
Complete-InstallerDiagnostics $ctx
Assert ($script:values.DumpType -eq 2) 'one failed restore stopped remaining restores'
Assert ($ctx.Errors -contains 'dump_settings_restore_failed') 'restore error was swallowed'
Assert (Microsoft.PowerShell.Management\\Test-Path -LiteralPath (Join-Path $ctx.Directory 'installer-diagnostics.json')) 'summary not preserved'
`))

  it('removes only its new empty key and rejects non-CI activation before registry access', () => run(fakeRegistry + `
$script:keyExisted=$false;$script:values=@{};$script:kinds=@{}
Enable-InstallerCrashDumps $ctx
Restore-InstallerCrashDumps $ctx
Assert (-not $script:keyExisted) 'new empty exact key was not removed'
$env:CI='false';$rejected=$false
try { Enable-InstallerCrashDumps $ctx } catch { $rejected=$true }
Assert $rejected 'non CI configuration was accepted'
`))

  it('correlates real event XML by name/PID/time and excludes unrelated fields', () => run(`
$start=Get-Date
$installer='C:\\build\\Claude-Code-Haha-0.6.37-win-x64.exe'
$xml='<Event><EventData><Data Name="AppName">Claude-Code-Haha-0.6.37-win-x64.exe</Data><Data Name="ProcessId">0x2a</Data><Data Name="AppPath">C:\\build\\Claude-Code-Haha-0.6.37-win-x64.exe</Data><Data Name="ModuleName">System.dll</Data><Data Name="ModulePath">C:\\Users\\secret-user\\System.dll</Data><Data Name="ExceptionCode">c0000005</Data><Data Name="FaultingOffset">1234</Data><Data Name="Secret">DO_NOT_EXPORT</Data></EventData></Event>'
$event=[pscustomobject]@{Id=1000;ProviderName='Application Error';TimeCreated=$start;Xml=$xml}
$event | Add-Member ScriptMethod ToXml { return $this.Xml }
$hit=Convert-InstallerFailureEvent $event $installer 42 $start $start
Assert ($hit.exceptionCode -eq 'c0000005') 'matching crash not projected'
$encoded=$hit | ConvertTo-Json
Assert (-not $encoded.Contains('DO_NOT_EXPORT') -and -not $encoded.Contains('secret-user')) 'sensitive XML/path leaked'
Assert ($null -eq (Convert-InstallerFailureEvent $event $installer 43 $start $start)) 'wrong PID accepted'
$event.TimeCreated=$start.AddMinutes(-1)
Assert ($null -eq (Convert-InstallerFailureEvent $event $installer 42 $start $start)) 'stale crash accepted'
$event.Id=1001;$event.ProviderName='Windows Error Reporting';$event.TimeCreated=$start
$event.Xml='<Event><EventData><Data Name="P1">Claude-Code-Haha-0.6.37-win-x64.exe</Data><Data Name="EventName">APPCRASH</Data><Data Name="P4">System.dll</Data><Data Name="P7">c0000005</Data><Data Name="P8">1234</Data></EventData></Event>'
$wer=Convert-InstallerFailureEvent $event $installer 42 $start $start
Assert ($wer.correlation -eq 'name_time_only') 'WER falsely claims PID correlation'
`))

  it('records signed exception code even when event collection fails', () => run(`
function Get-WinEvent { throw 'PRIVATE RAW ERROR' }
function Start-Sleep {}
$ctx=New-InstallerDiagnostics -Installer 'C:\\build\\Claude-Code-Haha-0.6.37-win-x64.exe' -Directory $fixtureRoot
Add-InstallerFailureDiagnostics $ctx 'Fresh install' 42 (Get-Date) (Get-Date) -1073741819
$json=Get-Content -LiteralPath (Join-Path $fixtureRoot 'installer-diagnostics.json') -Raw
Assert ($json.Contains('0xC0000005') -and $json.Contains('event_collection_failed')) 'failure evidence missing'
Assert (-not $json.Contains('PRIVATE RAW ERROR')) 'raw error leaked'
`))

  it('preserves the real checked-process failure when diagnostics itself throws', () => run(`
$errors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(smoke)},[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-CheckedProcess'},$true)
Invoke-Expression $function.Extent.Text
$installer='C:\\fixture\\installer.exe'
$installerDiagnostics=New-InstallerDiagnostics $installer $fixtureRoot
function Start-Process {
 $fake=[pscustomobject]@{Id=42;ExitCode=-1073741819}
 $fake | Add-Member ScriptMethod WaitForExit {return $true}
 $fake | Add-Member ScriptMethod Dispose {}
 return $fake
}
function Add-InstallerFailureDiagnostics { throw 'diagnostic fixture failure' }
$caught=''
try { Invoke-CheckedProcess -FilePath $installer -Stage 'Fresh install' -Arguments @('/S') } catch {$caught=$_.Exception.Message}
Assert ($caught -eq 'Fresh install failed with process exit code -1073741819.') 'original failure was swallowed or replaced'
Assert ($installerDiagnostics.Errors -contains 'failure_diagnostics_failed') 'secondary failure missing'
`))

  it('keeps the original smoke throw and finalizes diagnostics before restoring environment', () => {
    const code = readFileSync(smoke, 'utf8')
    expect(code).toContain('throw "$Stage failed with process exit code $($process.ExitCode)."')
    expect(code).toContain('if ($null -eq $primaryFailure) { throw }')
    expect(code.indexOf('Complete-InstallerDiagnostics')).toBeLessThan(code.lastIndexOf('foreach ($name in $savedEnvironment.Keys)'))
  })
})
