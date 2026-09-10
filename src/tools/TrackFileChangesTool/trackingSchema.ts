import { z } from 'zod/v4'

export const trackingPathsSchema = z.strictObject({
  file_paths: z.array(z.string().min(1)).max(1000).optional(),
  patterns: z.array(z.object({
    base_dir: z.string().min(1),
    include: z.array(z.string().min(1)).min(1),
    exclude: z.array(z.string().min(1)).optional(),
  })).max(100).optional(),
}).refine(input => Boolean(input.file_paths?.length || input.patterns?.length), 'Provide file_paths or patterns')
const shellFileChangesObjectSchema = z.union([
  z.strictObject({ read_only: z.literal(true) }),
  trackingPathsSchema,
])

// Some models serialize nested JSON objects as strings. Decode one JSON layer,
// then enforce exactly the same declaration contract (never infer read-only).
export const shellFileChangesSchema = z.preprocess(value => {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}, shellFileChangesObjectSchema).describe('Optional file-change tracking for known write targets. Pass an object with file_paths or patterns (base_dir/include/exclude); the runtime preserves targets BEFORE execution. Omit for ordinary commands and read-only scripts. {read_only:true} is also accepted. This metadata does not grant command permissions. Explicit registrations must succeed before execution.')

export type ShellFileChanges = z.infer<typeof shellFileChangesSchema>
