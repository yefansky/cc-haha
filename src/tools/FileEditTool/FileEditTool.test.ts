import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { FileEditTool } from './FileEditTool.js'
import { FileWriteTool } from '../FileWriteTool/FileWriteTool.js'
import iconv from 'iconv-lite'

const temporaryDirectories: string[] = []
const originalSimple = process.env.CLAUDE_CODE_SIMPLE
const originalDisableCheckpoints =
  process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING

beforeEach(() => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
})

afterEach(async () => {
  if (originalSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
  else process.env.CLAUDE_CODE_SIMPLE = originalSimple

  if (originalDisableCheckpoints === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  } else {
    process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING =
      originalDisableCheckpoints
  }

  await Promise.all(
    temporaryDirectories.splice(0).map(path =>
      rm(path, { recursive: true, force: true }),
    ),
  )
})

function makeToolUseContext(): ToolUseContext {
  return {
    readFileState: new Map(),
    abortController: new AbortController(),
    updateFileHistoryState: () => {},
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as unknown as ToolUseContext
}

describe('FileEditTool indentation matching', () => {
  test('edits a unique tab-indented target from a space-indented input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-edit-'))
    temporaryDirectories.push(root)
    const directory = join(root, '中文目录')
    const filePath = join(directory, 'Tab 样例.txt')
    await mkdir(directory)
    await writeFile(filePath, '\t\t中文目标：旧值\n\t相邻内容\n', 'utf8')

    const context = makeToolUseContext()
    await FileReadTool.call({ file_path: filePath }, context)

    const input = {
      file_path: filePath,
      old_string: '    中文目标：旧值',
      new_string: '    中文目标：新值',
    }
    await expect(FileEditTool.validateInput(input, context)).resolves.toEqual({
      result: true,
      meta: { actualOldString: '\t\t中文目标：旧值' },
    })

    await FileEditTool.call(
      input,
      context,
      undefined,
      { uuid: 'indentation-test' } as never,
    )

    expect(await readFile(filePath, 'utf8')).toBe(
      '\t\t中文目标：新值\n\t相邻内容\n',
    )
  })
})

describe('Edit and Write preserve existing file encoding', () => {
  const original = '-- 中文注释：保持原样\r\nlocal value = "旧值"\r\n'
  const expected = original.replace('旧值', '新值')
  const encoders = {
    gbk: (text: string) => iconv.encode(text, 'gbk'),
    utf8: (text: string) => Buffer.from(text),
    'utf8-bom': (text: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
  }
  for (const [encoding, encode] of Object.entries(encoders)) {
    for (const tool of ['Edit', 'Write']) {
      test(`${tool} preserves ${encoding}, Chinese comments and BOM bytes`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'cc-haha-encoding-'))
        temporaryDirectories.push(root)
        const filePath = join(root, '中文脚本.lua')
        await writeFile(filePath, encode(original))
        const context = makeToolUseContext()
        await FileReadTool.call({ file_path: filePath }, context)
        expect(context.readFileState.get(filePath)?.content).toContain('中文注释：保持原样')
        if (tool === 'Edit') {
          const input = { file_path: filePath, old_string: '旧值', new_string: '新值' }
          expect((await FileEditTool.validateInput(input, context)).result).toBe(true)
          await FileEditTool.call(input, context, undefined, { uuid: 'encoding-test' } as never)
        } else {
          await FileWriteTool.call({ file_path: filePath, content: expected }, context, undefined, { uuid: 'encoding-test' } as never)
        }
        expect(await readFile(filePath)).toEqual(encode(expected))
      })
    }
  }

  for (const tool of ['Edit', 'Write']) {
    test(`${tool} refuses unrepresentable GBK characters and keeps original bytes`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'cc-haha-encoding-'))
      temporaryDirectories.push(root)
      const filePath = join(root, '原样.lua')
      const bytes = iconv.encode(original, 'gbk')
      await writeFile(filePath, bytes)
      const context = makeToolUseContext()
      await FileReadTool.call({ file_path: filePath }, context)
      const operation = tool === 'Edit'
        ? FileEditTool.call({ file_path: filePath, old_string: '旧值', new_string: '😀' }, context, undefined, { uuid: 'encoding-test' } as never)
        : FileWriteTool.call({ file_path: filePath, content: '😀' }, context, undefined, { uuid: 'encoding-test' } as never)
      await expect(operation).rejects.toThrow('GBK cannot represent')
      expect(await readFile(filePath)).toEqual(bytes)
    })
  }
})
