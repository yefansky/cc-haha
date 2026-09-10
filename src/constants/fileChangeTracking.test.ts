import { expect, test } from 'bun:test'
import { fileChangeTrackingInstruction } from './fileChangeTracking.js'
import { getSimplePrompt } from '../tools/BashTool/prompt.js'
test('guidance depends on available registration tool and is delivered in shell prompt', () => {
  expect(fileChangeTrackingInstruction(new Set(['Read']))).toBeNull()
  const instruction = fileChangeTrackingInstruction(new Set(['TrackFileChanges']))!
  expect(instruction).toContain('Before any authorized local file')
  expect(instruction).toContain('wait for registration')
  expect(instruction.toLowerCase()).toContain('only actual content changes')
  expect(instruction).toContain('file_changes')
  expect(getSimplePrompt()).toContain(instruction)
})
