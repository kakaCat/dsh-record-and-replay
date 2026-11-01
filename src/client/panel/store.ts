import { create } from 'zustand'

export interface PanelUiState {
  root: string | undefined
  selectedRecordingId: string | undefined
  selectedRunId: string | undefined
  search: string
  /** Explicit expand/collapse overrides; the tree defaults to expanded. */
  expanded: Record<string, boolean>
  setRoot(root: string): void
  /** Switch project and select one recording in a single update (cross-project search). */
  openRecording(root: string, recordingId: string): void
  selectRecording(recordingId: string | undefined): void
  selectRun(runId: string | undefined): void
  setSearch(query: string): void
  toggleExpanded(key: string): void
  isExpanded(key: string, defaultOpen?: boolean): boolean
}

export const usePanelStore = create<PanelUiState>((set, get) => ({
  root: undefined,
  selectedRecordingId: undefined,
  selectedRunId: undefined,
  search: '',
  expanded: {},

  setRoot(root) {
    if (get().root === root) return
    set({
      root,
      selectedRecordingId: undefined,
      selectedRunId: undefined,
      search: '',
      expanded: {},
    })
  },

  openRecording(root, recordingId) {
    set({
      root,
      selectedRecordingId: recordingId,
      selectedRunId: undefined,
      search: '',
      expanded: {},
    })
  },

  selectRecording(recordingId) {
    set({ selectedRecordingId: recordingId, selectedRunId: undefined })
  },

  selectRun(runId) {
    set({ selectedRunId: runId })
  },

  setSearch(query) {
    set({ search: query })
  },

  toggleExpanded(key) {
    const current = get().isExpanded(key)
    set((state) => ({ expanded: { ...state.expanded, [key]: !current } }))
  },

  isExpanded(key, defaultOpen = true) {
    return get().expanded[key] ?? defaultOpen
  },
}))
