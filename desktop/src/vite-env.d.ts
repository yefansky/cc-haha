/// <reference types="vite/client" />

declare const __PACKAGED_CHANGELOG__: { version: string, markdown: string } | null
declare const __PACKAGED_CHANGELOG_HISTORY__: Array<{ version: string, date: string, markdown: string, source: 'backfilled' | 'generated' }>
