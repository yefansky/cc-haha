---
title: Headless provider commands
nav_title: Providers
description: Discover commands offline, select saved providers, inspect model and pricing evidence, report usage and run coding tasks.
order: 4
---

# Headless provider commands

The `cc-haha` command reuses the existing coding agent, tools and saved provider configurations. It reads and edits files, executes commands and reports model, pricing and usage evidence. KSCC and Token Hub reuse personal authorization without installing their clients. The command never opens a window or dialog.

## Discovery for people and coding agents

```powershell
cc-haha help
cc-haha help models
cc-haha models --help
cc-haha capabilities --json
```

Help provides teaching examples; `help <command>` and `<command> --help` are equivalent. `capabilities` describes parameters, selection constraints, modes, support status, success/error schemas and recovery actions as machine-readable data. These commands do not read credentials or require network access, the desktop app or a source checkout. The executable embeds the manual. Use `help --manual` for the complete reference. The updated installer also generates `HELP.md`, `README.md` and `capabilities.json` beside the wrapper from the same executable. Old installed wrappers do not gain these files automatically; rerun the updated installer with an updated executable.

A coding agent should read capabilities, list providers and choose an exact ID, inspect that ID's models/pricing/usage, then select a model and minimum tool permissions. `saved-provider-id` and `model-id` in examples are placeholders to replace with actual discovered IDs.

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

First place a verified executable at a stable path, then generate its wrapper and offline documentation. **The installer references `-Executable`; it does not copy or relocate that file. Do not move or delete it after installation.** For example:

```powershell
New-Item -ItemType Directory -Force 'G:\tools\cc-haha-cli\runtime' | Out-Null
Copy-Item -LiteralPath 'G:\build\cc-haha.exe' -Destination 'G:\tools\cc-haha-cli\runtime\cc-haha.exe'
& .\scripts\install-headless-cli.ps1 -Executable 'G:\tools\cc-haha-cli\runtime\cc-haha.exe' -InstallDirectory 'G:\tools\cc-haha-cli\bin' -ConfigDirectory "$env:USERPROFILE\.claude" -AddToUserPath
```

Replace the configuration directory with the one your desktop app actually uses. `-InstallDirectory` itself contains the wrapper and documents; `-AddToUserPath` adds it directly without another `bin` level. Keep the same-named EXE out of the command directory so it cannot bypass the configuration wrapper. Open a new terminal afterwards. An already running GUI inherits the old PATH; use `G:\tools\cc-haha-cli\bin\cc-haha.cmd` without interrupting it. Explicit configuration is a wrapper fallback; an existing `CLAUDE_CONFIG_DIR` takes priority. Source wrappers and a bare EXE keep the standard default below.

Use the same configuration directory as your logged-in desktop application. The command honors `CLAUDE_CONFIG_DIR`; otherwise it uses `.claude` in your local user directory. When the desktop launcher uses another directory, set this variable to that existing directory first. Do not copy tokens across users or machines. Keep new configuration directories in your own protected user directory; existing custom desktop directories retain their location and permissions.

## Login

```powershell
& $cc login --provider kscc
& $cc login --provider tokenhub
```

Existing authorization is reused. The KSCC alias can print an authorization URL when needed; open it manually. Token Hub reuses and refreshes saved authorization. First KOA login, older installations without manager refresh credentials and required reauthentication need personal authorization in the desktop app. Custom providers return `LOGIN_UNSUPPORTED` instead of pretending to log in. Expired enterprise credentials selected by exact ID need a precise desktop reconnection to avoid replacing another configuration of the same kind.

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

**JSON v2 migration:** check `schema_version=2`. Existing cost fields remain, but `total_cost_usd` and `modelUsage.<model>.costUSD` are `null` when upstream billing evidence is unknown. The former client estimate appears only under `cost.client_estimate` with `billed=false`; inspect `cost.status` instead of assuming a number. Preflight failures can have `provider_id=null` and `model=null`. See `capabilities.output_schemas.error`; do not parse every failure as a success response.

## Models and quota

```powershell
& $cc providers --json
& $cc models --provider kscc
& $cc models --provider tokenhub
& $cc models --provider saved-provider-id --json --no-network
& $cc pricing --all --json
& $cc usage --provider tokenhub --json
```

`providers` lists all locally saved configurations with stable `id/provider_id`, name, preset, active status and per-query capabilities. It does not list every vendor on the internet or expose keys/credential-bearing endpoints. Exact IDs take precedence over `kscc` and `tokenhub` aliases. Multiple matching configurations return `AMBIGUOUS_PROVIDER`; choose a saved ID. An ID named `all` remains an exact ID.

Independent coding runs support the ordinary `anthropic_compatible` runtime and reuse existing Anthropic, OpenAI Chat and Responses adapters. Special official-account `openai_oauth` and `grok_oauth` runtimes are not expanded in this change: saved configurations/catalogs/pricing status/local usage remain discoverable, but provider discovery marks running unsupported and execution returns `RUNTIME_UNSUPPORTED` instead of secretly depending on a desktop host or default port.

`models`, `pricing` and `usage` require exactly one of `--provider <ID-or-alias>` or `--all`. Aggregation retains successes and safe per-item errors; partial/error status returns a nonzero exit code. Unsupported query parameters are rejected rather than silently ignored.

Models include protocol/capability/context values and evidence sources, live/configured freshness and permission evidence. `--no-network` reads saved catalogs or mappings; `freshness=configured` is not a live catalog. Unknown capabilities have source `unknown`; unknown context is `null`. Listing, advertised availability, quota flags and call permission are separate evidence. Unprobed `call_access` and `permission.status` remain `unknown`; no paid probes are made for every model. KSCC `quota_limited=false` does not prove access.

Pricing currently lacks verified account rates. It returns `status=unknown`, null currency and input/output/cache rates, source evidence and check time, including per-model entries. The normalized unit is per million tokens; that does not imply a known rate. The command does not invent pricing endpoints, apply Claude rates, interpret unknown as free, or confuse balance with pricing.

Usage reports rolling 1-hour, 24-hour and 7-day token counts for new CLI requests on this machine, grouped by stable `provider_id` and model and deduplicated per request. Accounts of the same preset stay separate. Old v1 records lacking IDs appear only in `legacy_usage`; their account is not guessed and they must not be added to new totals. Cached tokens stay separate. Historical desktop activity, other clients and other machines are excluded. No records does not mean the account never spent tokens.

`provider_preset` identifies the actual selected preset, or `null` when no saved configuration was selected. Aggregators should verify the provider role with this field instead of interpreting a custom ID named `kscc` as enterprise KSCC or including its old records. Unknown or mismatched roles should retain an explicit state without numeric quota values.

KSCC and custom providers without a balance interface report unsupported numerical balances explicitly. Token Hub queries account-wide windows, distinguishing missing authorization, unsupported endpoints and temporary failures. Model API keys, model rates and account balances are independent facts. Do not add balances observed on two machines.

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
