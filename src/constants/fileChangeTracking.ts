export const FILE_CHANGE_TRACKING_INSTRUCTION = 'Before any authorized local file creation, modification, deletion, or rename that bypasses Write/Edit/NotebookEdit, call TrackFileChanges and wait for registration to finish. Supply explicit file_paths (including new files and both rename endpoints) or base_dir/include/exclude glob patterns for batches. This applies to every command, interpreter, script, or other tool; do not infer edits from command text. Resolve failed or truncated registration before modifying those targets. Registration preserves the current baseline; only actual content changes belong in the session changed-files list. Never claim that registration recovers changes made before a baseline existed.'

export function fileChangeTrackingInstruction(enabledTools: Set<string>): string | null {
  return enabledTools.has('TrackFileChanges') ? FILE_CHANGE_TRACKING_INSTRUCTION : null
}
