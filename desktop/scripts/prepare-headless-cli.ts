import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getHeadlessCapabilities, renderHeadlessHelp } from '../../src/entrypoints/headlessCommandCatalog'

export async function prepareHeadlessCli(outputDir: string, targetTriple: string): Promise<void> {
  if (!targetTriple.includes('windows')) return
  const sidecar = `../resources/app.asar.unpacked/src-tauri/binaries/claude-sidecar-${targetTriple}.exe`
  await mkdir(outputDir, { recursive: true })
  const wrapper = [
    '@echo off', 'rem Managed by com.claude-code-haha.desktop; bundled headless CLI.',
    'setlocal DisableDelayedExpansion',
    'for /f "tokens=2 delims=:" %%A in (\'chcp\') do set "_CC_HAHA_CP=%%A"',
    'chcp 65001 >nul',
    `set "SIDECAR=%~dp0${sidecar.replaceAll('/', '\\')}"`,
    `if not exist "%SIDECAR%" set "SIDECAR=%~dp0..\\app.asar.unpacked\\src-tauri\\binaries\\claude-sidecar-${targetTriple}.exe"`,
    'if not exist "%SIDECAR%" (', '  echo cc-haha: installed runtime is missing. Repair the installation. 1>&2', '  chcp %_CC_HAHA_CP% >nul', '  exit /b 1', ')',
    'for %%I in ("%SIDECAR%") do set "APP_ROOT=%%~dpI"',
    '"%SIDECAR%" headless --app-root "%APP_ROOT%." --desktop-config %*',
    'set "_CC_HAHA_EXIT=%errorlevel%"', 'chcp %_CC_HAHA_CP% >nul', 'exit /b %_CC_HAHA_EXIT%', '',
  ].join('\r\n')
  const readme = '# cc-haha installed command line\n\nThis directory belongs to Claude Code Haha. No Bun, source checkout, or private-brain workspace is needed.\n\nStart with `cc-haha --help`, `cc-haha help models`, or `cc-haha capabilities --json`. Offline instructions are in HELP.md and capabilities.json.\n\nCommands outside the application installation are preserved. If another cc-haha command exists, use the installed bin/cc-haha.cmd by absolute path. If bin contains conflicting files, the installer preserves them during CLI registration; use resources/cli/cc-haha.cmd instead. Both wrappers execute the same bundled sidecar. Read resources/cli/registration-status.txt for installation diagnostics. Open a new terminal after installation to refresh PATH.\n\nThe installation tree belongs to the application: the existing application updater/uninstaller can remove the entire tree, including custom files placed there. Keep personal scripts elsewhere.\n\nThe wrapper uses the current calling user’s desktop app-mode.json, so default/custom storage follows the GUI. An explicit CLAUDE_CONFIG_DIR takes priority. It neither starts the GUI nor copies credentials. Updating this installation updates the shared runtime and these instructions.\n'
  await Promise.all([
    writeFile(path.join(outputDir, 'cc-haha.cmd'), wrapper),
    writeFile(path.join(outputDir, 'README.md'), readme),
    writeFile(path.join(outputDir, 'HELP.md'), renderHeadlessHelp(undefined, true)),
    writeFile(path.join(outputDir, 'capabilities.json'), `${JSON.stringify(getHeadlessCapabilities(), null, 2)}\n`),
    writeFile(path.join(outputDir, 'cli-manifest.json'), `${JSON.stringify({ schema_version: 1, owner: 'com.claude-code-haha.desktop', command: 'cc-haha', mode: 'headless', sidecar_relative_path: sidecar, config_resolution: 'desktop_app_mode' }, null, 2)}\n`),
  ])
}
