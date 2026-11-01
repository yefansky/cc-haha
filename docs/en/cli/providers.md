---
title: Headless provider commands
nav_title: Providers
description: Reuse KSCC and Token Hub authorization for headless coding tasks, model discovery and quota reporting on Windows.
order: 4
---

# Headless provider commands

The `cc-haha` command reuses the existing coding agent, tools and provider authorization. It can read and edit files, execute commands, list models and report usage without installing the KSCC or Token Hub clients. The command never opens a window or dialog.

## Installation and configuration

Install Git and Bun, obtain your cc-haha source checkout, then install locked dependencies. For a checkout at `G:\tools\cc-haha`:

```powershell
Set-Location G:\tools\cc-haha
$env:TEMP = 'G:\tools\cc-haha\.runtime\cli-temp'
$env:TMP = $env:TEMP
$env:BUN_INSTALL_CACHE_DIR = 'G:\tools\cc-haha\.runtime\bun-cache'
$env:npm_config_cache = 'G:\tools\cc-haha\.runtime\npm-cache'
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
bun install --frozen-lockfile
$cc = 'G:\tools\cc-haha\bin\cc-haha.cmd'
```

Neither the desktop application, frontend development server nor gateway needs to run. To use the short command in the current terminal, set `$env:PATH = 'G:\tools\cc-haha\bin;' + $env:PATH`.

For persistent use of a verified compiled executable, the included installer copies it to a stable directory and creates the command wrapper:

```powershell
& .\scripts\install-headless-cli.ps1 -Executable 'G:\build\cc-haha.exe' -InstallDirectory 'G:\tools\cc-haha-cli' -ConfigDirectory "$env:USERPROFILE\.claude" -AddToUserPath
```

Replace the configuration directory with the one your desktop application actually uses. `-AddToUserPath` adds the stable `bin` directory to the user PATH. Open a new terminal afterwards. An already running GUI inherits the old PATH; use the stable absolute wrapper path without interrupting that session. The installed wrapper uses the explicit configuration directory as its fallback, while a caller-provided `CLAUDE_CONFIG_DIR` takes priority. Source wrappers and a bare executable keep the standard default below.

Use the same configuration directory as your logged-in desktop application. The command honors `CLAUDE_CONFIG_DIR`; otherwise it uses `.claude` in your local user directory. When the desktop launcher uses another directory, set this variable to that existing directory first. Do not copy tokens across users or machines. Keep new configuration directories in your own protected user directory; existing custom desktop directories retain their location and permissions.

## Login

```powershell
& $cc login --provider kscc
& $cc login --provider tokenhub
```

Existing authorization is reused. KSCC can print an authorization URL for you to open manually; it does not launch a browser. Token Hub currently reuses and refreshes saved authorization. For first-time KOA login, older installations without manager refresh credentials, or server-required reauthentication, finish personal authorization in the cc-haha desktop application first. No background login window is opened.

Online Token Hub model and quota queries can refresh expired saved authorization once and persist rotated credentials. `usage --no-network` reads only local measurements and does not refresh. Never place tokens in command arguments, prompts, scripts or logs.

Manager authorization and the model API key are independent credentials. A model catalog or quota query requiring reauthentication does not prove the model key has expired. Calls to a known authorized model may still succeed; check both outcomes separately.

## One-shot coding tasks

```powershell
& $cc -p 'Reply OK' --provider kscc --model glm-5.1 --output-format json
& $cc -p 'Read README and explain how to run tests' --provider tokenhub --model '<model returned by models>' --cwd 'G:\work\project A'
& $cc -p 'Fix the failing test and verify it' --provider kscc --model glm-5.1 --cwd 'G:\work\project A' --allowed-tools 'Read,Edit,Write,PowerShell' --max-turns 12 --timeout-ms 600000
```

The third example explicitly grants file editing and PowerShell tools. Grant only permissions required by trusted tasks. Existing tool and path rules remain authoritative. The default noninteractive permission mode is `dontAsk`: tools needing ungranted approval are denied instead of opening a dialog. `--cwd` chooses a directory; it is not an operating-system sandbox.

Text output prints the result. JSON output is one object containing the result, actual model, ordinary input/output tokens, separate cache tokens, duration, run identity and exit status. `tool_usage` contains only tool names and attempt counts, without arguments. A count alone does not prove successful execution; consult `permission_denials` for denied requests. Parse stdout and send stderr to diagnostics. Check process exit code and result status for timeouts, missing authorization, restricted models and tool failures. Missing upstream usage must not be presented as measured zero consumption.

## Models and quota

```powershell
& $cc models --provider kscc
& $cc models --provider tokenhub
& $cc usage --provider tokenhub --json
```

Listing, catalog availability, quota restrictions and observed call permission are separate evidence. KSCC `quota_limited=false` does not prove model access. A 403 model restriction requires an authorized model or administrator action. Listing models does not issue paid probes to every model.

Usage reports rolling 1-hour, 24-hour and 7-day token counts for new CLI requests on this machine, grouped by provider and model and deduplicated per request. Cached tokens remain separate. Historical desktop activity, other clients and other machines are excluded. No records does not mean the account never spent tokens.

KSCC reports unsupported numerical balance explicitly; consult model listings for quota-limit flags. Token Hub queries account-wide quota windows, distinguishing missing authorization, unsupported endpoints and temporary failures. Do not add account balances observed on two machines.

Forecasts divide remaining money by observed account spending in the same currency and quota period, using at least two server snapshots one minute apart. Unknown or unlimited balances, insufficient samples and no positive spending produce no exhaustion date. If reset would happen first, no date beyond that reset is invented. Future spending can change. Offline local reporting is available with:

```powershell
& $cc usage --provider kscc --json --no-network
```

## Tasks delegated to another model

Invoke the same CLI through existing PowerShell or Bash tools to give another provider or model an independent subtask; no new scheduler is required:

```powershell
& 'G:\tools\cc-haha\bin\cc-haha.cmd' -p 'Read tests and list missing edge cases without editing files' --provider kscc --model glm-5.1 --cwd 'G:\work\project A' --output-format json
```

Concurrent processes have separate run identities, providers, models and working directories. Accounting follows each invocation instead of guessing from global defaults. Use separate directories or Git worktrees for concurrent editing to avoid file conflicts.

## A second Windows machine

Check out the same commit and install the same locked dependencies. Replace the example G-drive path with the actual second-machine path, such as `F:\tools\cc-haha`, including cache and temporary directories. Authorize locally as the user; do not copy the first machine's tokens.

Repeat a KSCC JSON reply, an authorized Token Hub model, both model lists and both usage commands. Then verify reading a fixture, editing it and executing a validation command in a temporary workspace. Success on one machine does not verify the second machine.
