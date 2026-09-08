export function isWorkspaceFolderEntryVisible(
  entry: { name: string; isDirectory: boolean },
  showHidden: boolean,
): boolean {
  return showHidden || !entry.isDirectory || !/^[._]/.test(entry.name)
}

/** Paths are relative to the displayed root; the root itself remains accessible. */
export function isWorkspacePathVisible(path: string, isDirectory: boolean, showHidden: boolean): boolean {
  if (showHidden) return true
  const segments = path.split(/[\\/]/).filter(segment => segment !== '' && segment !== '.' && segment !== '..')
  const directories = isDirectory ? segments : segments.slice(0, -1)
  return directories.every(name => isWorkspaceFolderEntryVisible({ name, isDirectory: true }, false))
}
