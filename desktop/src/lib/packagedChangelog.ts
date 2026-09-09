export function getPackagedChangelog(version: string) {
  // Embedded by Vite: available after installation, restart and without network.
  const notes = typeof __PACKAGED_CHANGELOG__ === 'undefined' ? null : __PACKAGED_CHANGELOG__
  return notes?.version === version ? notes.markdown : null
}

export function getPackagedChangelogHistory() {
  return typeof __PACKAGED_CHANGELOG_HISTORY__ === 'undefined' ? [] : __PACKAGED_CHANGELOG_HISTORY__
}
