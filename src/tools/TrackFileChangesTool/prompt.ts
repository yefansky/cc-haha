export const TRACK_FILE_CHANGES_TOOL_NAME = 'TrackFileChanges'

export const TRACK_FILE_CHANGES_PROMPT = `Register files BEFORE changing them through a shell, script, command, or another tool that bypasses Write/Edit. This saves their current contents for session change detection, comparisons, and restoration. It does not modify the files or count unchanged files as edits.

- Pass file_paths for explicit targets, including not-yet-created files. For deletion register the original path; for rename register both source and destination. Prefer absolute paths.
- For existing batches, use patterns with an absolute base_dir and include/exclude glob arrays. You may generate a file_paths array from a loop, but this tool never evaluates code or arbitrary expressions.
- Wait for registration to finish before running the modifying command. Inspect failed and truncated results; do not assume incomplete registration captured the entire batch.
- Write and Edit already track their own changes; no duplicate registration is needed for them.
- Bash and PowerShell can register automatically: include optional file_changes as a JSON object with file_paths or patterns in the same command call for known write targets. Ordinary commands and read-only scripts do not require registration. Executing a script does not mean the script file itself will be modified. Do not guess targets or scan an entire repository to satisfy tracking. Use a narrow base_dir for glob batches.
- Registration preserves the current baseline. It cannot reconstruct modifications that happened before a baseline was captured. Disabled history or a missing active snapshot is reported as a failure.`
