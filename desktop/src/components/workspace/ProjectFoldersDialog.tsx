import { useEffect, useId, useState } from 'react'
import { FolderPlus, X } from 'lucide-react'
import { DirectoryPicker } from '@/components/composite/DirectoryPicker'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useTranslation } from '@/i18n'
import { EMPTY_PROJECT_FOLDERS, normalizeProjectFolderKey, useProjectFoldersStore } from '@/stores/projectFoldersStore'

export function ProjectFoldersDialog({ projectPath, onClose }: { projectPath: string; onClose: () => void }) {
  const t = useTranslation()
  const pickerLabelId = useId()
  const project = useProjectFoldersStore((state) => state.projects[normalizeProjectFolderKey(projectPath)] ?? EMPTY_PROJECT_FOLDERS)
  const [query, setQuery] = useState('')
  const [selectedPath, setSelectedPath] = useState('')

  useEffect(() => {
    useProjectFoldersStore.getState().initializeProject(projectPath)
    setSelectedPath('')
    setQuery('')
  }, [projectPath])

  const folders = project.mountedRoots.filter((folder) => `${folder.label} ${folder.path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const selectedKey = normalizeProjectFolderKey(selectedPath)
  const canAdd = Boolean(selectedKey)
    && selectedKey !== normalizeProjectFolderKey(projectPath)
    && !project.mountedRoots.some((folder) => normalizeProjectFolderKey(folder.path) === selectedKey)

  return (
    <Modal open onClose={onClose} title={t('workspace.manageAttachedFolders')} width={640}
      footer={<Button onClick={onClose}>{t('workbench.close')}</Button>}
    >
      <div className="space-y-4">
        <p className="break-all text-xs text-[var(--color-text-secondary)]">{projectPath}</p>
        <p className="text-sm text-[var(--color-text-secondary)]">{t('workspace.attachedFoldersDescription')}</p>
        <div role="group" aria-labelledby={pickerLabelId} className="space-y-2">
          <span id={pickerLabelId} className="text-sm text-[var(--color-text-secondary)]">{t('workspace.selectAttachedFolder')}</span>
          <div className="flex flex-wrap items-center gap-2">
            <DirectoryPicker value={selectedPath} onChange={setSelectedPath} />
            <Button size="sm" disabled={!canAdd} onClick={() => {
              useProjectFoldersStore.getState().addMountedRoot(projectPath, selectedPath)
              setSelectedPath('')
            }}>
              <FolderPlus size={14} aria-hidden="true" />{t('workspace.addAttachedFolder')}
            </Button>
          </div>
        </div>
        <Input size="sm" label={t('workspace.searchAttachedFolders')} value={query} onChange={(event) => setQuery(event.target.value)} />
        <ul className="max-h-72 space-y-1 overflow-y-auto" aria-label={t('workspace.manageAttachedFolders')}>
          {folders.map((folder) => (
            <li key={normalizeProjectFolderKey(folder.path)} className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-[var(--color-text-primary)]">{folder.label}</div>
                <div className="break-all text-xs text-[var(--color-text-secondary)]">{folder.path}</div>
              </div>
              <IconButton icon={<X size={16} aria-hidden="true" />} label={t('workspace.removeAttachedFolder', { folder: folder.label })} hoverTone="danger"
                onClick={() => useProjectFoldersStore.getState().removeMountedRoot(projectPath, folder.path)} />
            </li>
          ))}
        </ul>
        {folders.length === 0 && <p className="text-sm text-[var(--color-text-secondary)]">{t(project.mountedRoots.length ? 'workspace.noMatchingAttachedFolders' : 'workspace.noAttachedFolders')}</p>}
      </div>
    </Modal>
  )
}
