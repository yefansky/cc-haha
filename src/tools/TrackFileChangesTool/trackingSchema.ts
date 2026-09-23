import { z } from 'zod/v4'

export const trackingPathsSchema = z.strictObject({
  manifest_path: z.string().min(1).optional().describe('Existing UTF-8 JSON array of absolute paths, or one absolute path per line; maximum 1 MiB / 500 entries. Before mode saves baselines for planned targets. Report mode treats entries only as candidates to compare against previously saved baselines; no baseline means unverified, not a reported change.'),
  file_paths: z.array(z.string().min(1)).max(1000).optional().describe('Absolute target paths. Before mode saves existing content or records that a new path is absent; include both rename endpoints. Report mode verifies candidates against saved baselines, including deleted paths. Unchanged paths are omitted and paths without baselines remain unverified.'),
  patterns: z.array(z.object({
    base_dir: z.string().min(1),
    include: z.array(z.string().min(1)).min(1),
    exclude: z.array(z.string().min(1)).optional(),
  })).max(100).optional().describe('Narrow pre-write output scope: absolute base_dir and relative include/exclude globs covering all expected output types. Use when output names are unknown; an existing empty directory is supported. Shell calls rescan the same scope after foreground completion, including failure, and compare content to verify creations, edits and deletions. Unchanged files and timestamp-only touches are omitted.'),
}).refine(input => Boolean(input.file_paths?.length || input.patterns?.length || input.manifest_path), 'Provide file_paths, patterns or manifest_path')
const shellFileChangesObjectSchema = z.union([
  z.strictObject({ read_only: z.literal(true) }),
  trackingPathsSchema,
])

// Some models serialize nested JSON objects as strings. Decode one JSON layer,
// then enforce exactly the same declaration contract (never infer read-only).
export const shellFileChangesSchema = z.preprocess(value => {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}, shellFileChangesObjectSchema).describe('For each writing command, declare pre-write baselines with {file_paths:[absolute paths]} or narrow {patterns:[{base_dir,include,exclude}]}; an existing {manifest_path:absolutePath} may list planned targets. Registration must succeed before execution. Foreground completion verifies content changes against these baselines, including on failure. Unknown output names require a declared output scope; a post-write manifest alone is insufficient. Omit for read-only commands; {read_only:true} is also accepted. This metadata does not grant command permissions.')

export type ShellFileChanges = z.infer<typeof shellFileChangesSchema>

export const shellManifestSchema = z.string().min(1).describe('Optional absolute path of a fresh manifest created by THIS command, which must not exist yet: UTF-8 JSON array of absolute candidate paths or one per line, flushed after each completed write. First declare file_changes.file_paths or a narrow file_changes.patterns output scope. Foreground completion imports candidates even on failure, but only pre-write baseline comparisons can verify changes; unsupported paths remain unverified. Background jobs must finish before TrackFileChanges mode report verifies their completed manifest. Never rerun the writer solely to repair tracking.')
