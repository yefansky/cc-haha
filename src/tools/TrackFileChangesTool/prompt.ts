export const TRACK_FILE_CHANGES_TOOL_NAME = 'TrackFileChanges'

export const TRACK_FILE_CHANGES_PROMPT = `Save a content baseline BEFORE an external write, then verify candidate files AFTER completion. Choose the mode explicitly.

BEFORE writing — mode="before" (default): preserve existing content and record absent explicit paths or a declared output scope. Use known file_paths, or narrow patterns when output names are unknown. An existing empty output directory is supported.
Examples:
  {"mode":"before","file_paths":["/absolute/existing.txt","/absolute/new.txt"]}
  {"mode":"before","patterns":[{"base_dir":"/absolute/output","include":["**/*.html","**/*.png"],"exclude":["cache/**"]}]}
  {"mode":"before","manifest_path":"/absolute/planned-paths.json"}
A before-mode manifest must already exist and list planned targets. Include both rename endpoints. Wait for completion; fix failed or truncated registrations BEFORE writing. Registered targets are baselines, not proof of changes.

AFTER the writer finishes — mode="report": compare candidate paths against their saved pre-write baselines. Content edits, creations and deletions verified by that comparison enter reported, the accepted changed-files inventory. Unchanged files are omitted. Paths without a pre-write baseline are unverified and MUST NOT enter the changed-files inventory. Reporting afterward cannot reconstruct a baseline or provide a missing undo backup.
Examples:
  {"mode":"report","file_paths":["/absolute/candidate.html","/absolute/deleted.txt"]}
  {"mode":"report","manifest_path":"/absolute/completed-candidates.json"}
Prefer explicit candidate paths or a manifest for reporting. A manifest is candidate data only: its entries can include unchanged or read-only files and are not proof of modification. Check reported, failed, truncated and unverified. Split oversized lists or retry verification when necessary; NEVER repeat a writer solely to repair tracking. If a baseline is missing, disclose the unverified paths.

Manifest format: a UTF-8 JSON array of absolute path strings, or one absolute path per line. Read as data only, not a script. Maximum manifest size 1 MiB; at most 500 manifest entries per call with a bounded path payload. Relative entries, malformed content and unreadable manifests fail validation.

For Bash/PowerShell prefer the SAME-call declaration on every writing command: file_changes:{file_paths:[...]} or file_changes:{patterns:[{base_dir,include,exclude}]}. Foreground completion compares against the pre-write baseline even on command failure. For unknown output names, declare the narrow output scope before execution. Optional file_changes_manifest must point to a fresh manifest the writer fills and flushes after each completed write; it supplies candidates within a previously declared baseline or scope, not independent proof. For background jobs, wait until writing ends, then use mode="report" with completed candidate paths or a manifest.

Read-only commands need no declaration. Write/Edit/NotebookEdit track themselves. Executed scripts, input files, stdout paths, recent timestamps and legacy written: receipts do not prove changes. A timestamp-only touch is not a content edit. Disabled history or a missing snapshot makes BEFORE registration fail; AFTER reporting cannot turn unsupported candidates into verified changes.`
