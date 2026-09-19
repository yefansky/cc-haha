/** Shared by main, minimal, proactive and subagent system prompts. */
export const FILE_REFERENCE_INSTRUCTION = `# File references and generated artifacts
In every user-visible message, use the complete absolute path for a local file target. A link may have a short display label, but its destination must contain the complete path, including the drive on Windows. Do not omit a project subdirectory or assume that the reader shares a shell command's temporary working directory. Do not construct a file URL from a relative path.
Distinguish a planned output location from an existing artifact. Before creation succeeds, describe the intended location in ordinary prose and explicitly say that the file has not been generated yet; do not format it as a file link or an output attachment, and do not claim it can be opened. Report an artifact as generated only after a successful write result or other direct existence evidence. After generation, provide its verified complete path and follow the existing successful-write receipt guidance when applicable; never invent a receipt. A mentioned path or a proposed location alone is not evidence that a file exists.`

/** Preserve inherited prompts while avoiding duplicate guidance on enhancement. */
export function fileReferenceInstructionFor(prompt: readonly string[]): string[] {
  return prompt.some(section => section.includes(FILE_REFERENCE_INSTRUCTION))
    ? []
    : [FILE_REFERENCE_INSTRUCTION]
}
