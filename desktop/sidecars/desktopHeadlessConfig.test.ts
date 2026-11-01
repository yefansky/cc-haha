import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyDesktopHeadlessConfig } from './desktopHeadlessConfig'

describe('installed headless configuration boundary', () => {
  it('follows desktop mode changes without persisting anything, and explicit environment wins', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'installed-cli-'))
    try {
      const roaming = path.join(root, '用户 空格& roaming')
      const data = path.join(roaming, 'Claude Code Haha')
      mkdirSync(data, { recursive: true })
      const modeFile = path.join(data, 'app-mode.json')
      const env: NodeJS.ProcessEnv = { APPDATA: roaming, USERPROFILE: root }
      const appRoot = path.join(root, 'installed/resources/app.asar.unpacked/src-tauri/binaries')
      expect(applyDesktopHeadlessConfig(['--desktop-config', 'providers'], appRoot, env)).toEqual(['providers'])
      expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(root, '.claude'))
      const current = path.join(root, '当前 自定义&=目录')
      const mode = JSON.stringify({ mode: 'portable', portable_dir: current })
      writeFileSync(modeFile, mode)
      env.CLAUDE_CONFIG_DIR = path.join(root, 'old-snapshot')
      env.CC_HAHA_APP_PORTABLE_DIR = '1'
      applyDesktopHeadlessConfig(['--desktop-config', '-p', '--desktop-config'], appRoot, env)
      expect(env.CLAUDE_CONFIG_DIR).toBe(current)
      expect(readFileSync(modeFile, 'utf8')).toBe(mode)
      env.CLAUDE_CONFIG_DIR = path.join(root, 'explicit')
      applyDesktopHeadlessConfig(['--desktop-config', 'usage'], appRoot, env)
      expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(root, 'explicit'))
      const promptArgs = ['-p', '--desktop-config']
      expect(applyDesktopHeadlessConfig(promptArgs, appRoot, env)).toBe(promptArgs)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('retains GUI fallback for invalid persisted mode without repairing the file', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'installed-cli-'))
    try {
      const userData = path.join(root, 'Claude Code Haha')
      mkdirSync(userData)
      const modeFile = path.join(userData, 'app-mode.json')
      writeFileSync(modeFile, '{broken')
      const env: NodeJS.ProcessEnv = { APPDATA: root, USERPROFILE: root }
      applyDesktopHeadlessConfig(['--desktop-config', 'help'], path.join(root, 'install'), env)
      expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(root, '.claude'))
      expect(readFileSync(modeFile, 'utf8')).toBe('{broken')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
