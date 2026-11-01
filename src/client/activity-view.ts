import {
  countSteps,
  defaultActivityFixture,
  defaultRecordingFixture,
  defaultReplayRunFixtures,
  visibleSteps,
  type ActivityFilter,
  type ActivityStep,
  type RecordingSummary,
  type ReplayRunStep,
  type ReplayRunSummary,
} from './activity-model.js'

declare global {
  interface Window {
    __activityState?: {
      cuaActionCount: number
      selectedStepId?: string
      selectedRecordingId?: string
      replayRequestedId?: string
      selectedReplayRunId?: string
      activeView: string
      filter: ActivityFilter
    }
  }
}

type ActivityView = 'live' | 'recordings' | 'replay'

interface ViewState {
  activeView: ActivityView
  filter: ActivityFilter
  selectedStepId: string | undefined
  selectedRecordingId: string | undefined
  replayRequestedId: string | undefined
  selectedReplayRunId: string | undefined
}

const STYLE_ID = 'dsh-activity-view-style'

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    :root { color-scheme: light; --border:#dfe5e7; --muted:#667173; --text:#172022; --accent:#1b6c80; --ok:#1e7b4f; --bad:#b4232a; --run:#8a520f; --bg:#f4f7f8; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; background:var(--bg); color:var(--text); }
    .activity-shell { width:min(1180px,calc(100% - 64px)); margin:24px auto 48px; background:#fff; border:1px solid var(--border); border-radius:8px; overflow:hidden; }
    .topbar { height:56px; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:0 16px; border-bottom:1px solid var(--border); background:#fbfcfc; }
    .brand { font-weight:650; white-space:nowrap; }
    .session { color:var(--muted); font-size:13px; white-space:nowrap; }
    .tabs { display:flex; gap:4px; }
    .tab { border:1px solid transparent; background:transparent; padding:8px 12px; border-radius:6px; cursor:pointer; color:var(--muted); }
    .tab[aria-selected="true"] { color:var(--accent); background:#e9f2f4; border-color:#c8dde2; }
    .panel { padding:16px; }
    .live-grid { display:grid; grid-template-columns:minmax(0,1fr) 360px; gap:16px; min-height:560px; }
    .timeline-panel, .detail-panel { border:1px solid var(--border); border-radius:8px; background:#fff; min-width:0; }
    .filters { display:flex; gap:8px; padding:12px; border-bottom:1px solid var(--border); }
    .filter { border:1px solid var(--border); background:#fff; border-radius:999px; padding:6px 10px; cursor:pointer; color:var(--muted); }
    .filter[data-active="true"] { color:var(--accent); border-color:#a9ccd4; background:#eef6f8; }
    .timeline { list-style:none; margin:0; padding:0; }
    .step-row { height:72px; display:grid; grid-template-columns:34px 70px minmax(0,1fr) 92px; align-items:center; gap:10px; padding:0 12px; border-bottom:1px solid #edf1f2; cursor:pointer; }
    .step-row:hover { background:#f8fbfb; }
    .step-row[data-selected="true"] { background:#e9f3f5; }
    .status { display:inline-flex; align-items:center; gap:6px; font-size:13px; white-space:nowrap; }
    .status-success { color:var(--ok); } .status-failure { color:var(--bad); } .status-running { color:var(--run); }
    .seq { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); font-size:12px; }
    .summary { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .duration { text-align:right; color:var(--muted); font-variant-numeric:tabular-nums; }
    .detail-header { padding:14px 14px 10px; border-bottom:1px solid var(--border); font-weight:650; }
    .detail-body { padding:14px; display:grid; gap:10px; color:#263133; }
    .detail-label { color:var(--muted); font-size:12px; margin-bottom:2px; }
    .empty { padding:28px 18px; color:var(--muted); }
    .placeholder { min-height:420px; display:grid; place-items:center; color:var(--muted); border:1px dashed var(--border); border-radius:8px; margin:16px; }
    .recordings-grid { display:grid; grid-template-columns:minmax(0,1fr) 330px; gap:16px; min-height:520px; }
    .recording-table { width:100%; border-collapse:collapse; }
    .recording-row { height:56px; border-bottom:1px solid #edf1f2; cursor:pointer; }
    .recording-row:hover { background:#f8fbfb; }
    .recording-row[data-selected="true"] { background:#e9f3f5; }
    .recording-row th, .recording-row td { text-align:left; padding:0 12px; }
    .status-pill { display:inline-flex; align-items:center; border-radius:999px; padding:3px 8px; font-size:12px; border:1px solid var(--border); }
    .status-pill.completed { color:var(--ok); border-color:#bfe3cf; background:#f2faf6; }
    .status-pill.interrupted { color:var(--run); border-color:#ecd9ae; background:#fff8e8; }
    .replay-button { border:1px solid #a9ccd4; background:#eef6f8; color:var(--accent); border-radius:6px; padding:6px 10px; cursor:pointer; white-space:nowrap; }
    .replay-button[aria-disabled="true"] { border-color:var(--border); background:#f3f5f5; color:var(--muted); cursor:not-allowed; }
    .recording-detail { border:1px solid var(--border); border-radius:8px; background:#fff; padding:14px; display:grid; gap:10px; align-content:start; }
    .path { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; overflow-wrap:anywhere; }
    .report-grid { display:grid; grid-template-columns:minmax(0,1fr) 330px; gap:16px; min-height:560px; }
    .run-summary { border:1px solid var(--border); border-radius:8px; padding:12px; display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin-bottom:12px; }
    .run-switch { display:flex; gap:8px; }
    .run-switch button { border:1px solid var(--border); background:#fff; border-radius:6px; padding:6px 10px; cursor:pointer; }
    .run-switch button[data-active="true"] { color:var(--accent); border-color:#a9ccd4; background:#eef6f8; }
    .run-steps { list-style:none; margin:0; padding:0; border:1px solid var(--border); border-radius:8px; background:#fff; }
    .run-step-row { height:72px; display:grid; grid-template-columns:80px 86px minmax(0,1fr) 130px; align-items:center; gap:10px; padding:0 12px; border-bottom:1px solid #edf1f2; }
    .run-step-row[data-status="error"] { background:#fff7f6; }
    .run-step-row[data-status="skipped"] { color:var(--muted); background:#fafbfb; }
    .evidence-panel { border:1px solid var(--border); border-radius:8px; background:#fff; padding:14px; display:grid; gap:10px; align-content:start; }
    .evidence-thumb { height:150px; border:1px dashed #b8c4c7; border-radius:6px; background:linear-gradient(135deg,#f8fbfb,#eef3f4); display:grid; place-items:center; color:var(--muted); }
    @media (max-width: 1120px) { .live-grid, .recordings-grid, .report-grid { grid-template-columns:1fr; } }
  `
  document.head.appendChild(style)
}

function statusLabel(status: ActivityStep['status']): string {
  switch (status) {
    case 'success': return '✓ 成功'
    case 'failure': return '✕ 失败'
    case 'running': return '● 进行中'
  }
}

function renderTabs(state: ViewState): string {
  const tabs: ReadonlyArray<{ id: ActivityView; label: string }> = [
    { id: 'live', label: '实时活动' },
    { id: 'recordings', label: '录制库' },
    { id: 'replay', label: '回放报告' },
  ]
  return tabs.map((tab) => `
    <button class="tab" role="tab" type="button" data-testid="tab-${tab.id}" data-view="${tab.id}" aria-selected="${String(state.activeView === tab.id)}">${tab.label}</button>
  `).join('')
}

function renderFilters(steps: readonly ActivityStep[], state: ViewState): string {
  const counts = countSteps(steps)
  const filters: ReadonlyArray<{ id: ActivityFilter; label: string; count: number }> = [
    { id: 'all', label: '全部', count: counts.all },
    { id: 'success', label: '成功', count: counts.success },
    { id: 'failure', label: '失败', count: counts.failure },
  ]
  return filters.map((filter) => `
    <button class="filter" type="button" data-testid="filter-${filter.id}" data-filter="${filter.id}" data-active="${String(state.filter === filter.id)}">${filter.label} ${filter.count}</button>
  `).join('')
}

function renderTimeline(steps: readonly ActivityStep[], state: ViewState): string {
  const rows = visibleSteps(steps, state.filter)
  if (rows.length === 0) {
    return '<li class="empty" data-testid="activity-empty">当前筛选下暂无步骤</li>'
  }
  return rows.map((step) => `
    <li class="step-row" data-testid="step-row" data-step-id="${step.id}" data-status="${step.status}" data-selected="${String(state.selectedStepId === step.id)}">
      <span class="seq">${step.id.replace('step_', '#')}</span>
      <span class="status status-${step.status}">${statusLabel(step.status)}</span>
      <span class="summary"><strong>${step.action}</strong> · ${step.summary}</span>
      <span class="duration">${step.durationMs} ms</span>
    </li>
  `).join('')
}

function renderDetail(steps: readonly ActivityStep[], state: ViewState): string {
  const selected = steps.find((step) => step.id === state.selectedStepId)
  if (selected === undefined) {
    return '<div class="empty" data-testid="activity-empty">选择一个步骤查看详情</div>'
  }
  const advice = selected.advice === undefined ? '无' : selected.advice
  const error = selected.errorCode === undefined ? '无' : selected.errorCode
  return `
    <div class="detail-header" data-testid="detail-title">${selected.action} · ${selected.id}</div>
    <div class="detail-body">
      <div><div class="detail-label">目标</div><div>${selected.targetLabel ?? '当前页面'}</div></div>
      <div><div class="detail-label">URL</div><div>${selected.url ?? 'about:blank'}</div></div>
      <div><div class="detail-label">时间</div><div>${selected.startedAt} · ${selected.durationMs} ms</div></div>
      <div><div class="detail-label">错误码</div><div>${error}</div></div>
      <div><div class="detail-label">建议</div><div>${advice}</div></div>
    </div>
  `
}

function renderRecordingsView(recordings: readonly RecordingSummary[], state: ViewState): string {
  const selected = recordings.find((recording) => recording.id === state.selectedRecordingId) ?? recordings[0]
  const rows = recordings.map((recording) => {
    const disabled = recording.status === 'interrupted'
    const label = disabled ? '仅可查看' : '查看回放'
    return `
      <tr class="recording-row" data-testid="recording-row" data-recording-id="${recording.id}" data-selected="${String(selected?.id === recording.id)}">
        <td>${recording.title}</td>
        <td><span class="status-pill ${recording.status}">${recording.status}</span></td>
        <td>${recording.stepCount}</td>
        <td>${(recording.durationMs / 1000).toFixed(1)} s</td>
        <td>${Math.round(recording.sizeBytes / 1024)} KiB</td>
        <td><button class="replay-button" type="button" data-testid="replay-recording" data-replay-recording="${recording.id}" aria-disabled="${String(disabled)}" ${disabled ? 'disabled' : ''}>${label}</button></td>
      </tr>
    `
  }).join('')

  const detail = selected === undefined
    ? '<div class="empty" data-testid="activity-empty">选择一条 Recording 查看存储结构</div>'
    : `
      <div class="detail-header" data-testid="recording-detail-title">${selected.title}</div>
      <div class="detail-body">
        <div><div class="detail-label">状态</div><div>${selected.status}</div></div>
        <div><div class="detail-label">目录</div><div class="path">.dsh/record-and-replay/recordings/${selected.id}/</div></div>
        <div><div class="detail-label">文件</div><div class="path">manifest.json · steps.jsonl · assets/ · runs/</div></div>
        <div><div class="detail-label">说明</div><div>${selected.status === 'interrupted' ? '该录制中断，仅可查看，不可直接回放。' : '该录制已完成，可进入回放报告。'}</div></div>
      </div>
    `

  return `
    <main class="panel" data-testid="recordings-view">
      <div class="recordings-grid">
        <section class="timeline-panel">
          <table class="recording-table" aria-label="Recording 列表">
            <thead><tr><th>标题</th><th>状态</th><th>步骤</th><th>耗时</th><th>大小</th><th>动作</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </section>
        <aside class="recording-detail" data-testid="recording-detail">${detail}</aside>
      </div>
    </main>
  `
}

function replayStepStatusLabel(status: ReplayRunStep['status']): string {
  switch (status) {
    case 'success': return '成功'
    case 'error': return '失败'
    case 'skipped': return '未执行'
  }
}

function renderReplayView(
  state: ViewState,
  fixtures: ReturnType<typeof defaultReplayRunFixtures>,
): string {
  const selectedId = state.selectedReplayRunId ?? 'failed'
  const run: ReplayRunSummary = selectedId === 'completed' ? fixtures.completedRun : fixtures.failedRun
  const steps: readonly ReplayRunStep[] = selectedId === 'completed' ? fixtures.completedSteps : fixtures.failedSteps
  const sourceRecording = state.replayRequestedId ?? run.recordingId
  const statusLabelText = run.status === 'failed' ? 'failed' : 'completed'
  const notExecutedNote = run.status === 'failed' ? '第 16 步起未执行' : '全部步骤已执行'
  const stepRows = steps.map((step) => `
    <li class="run-step-row" data-testid="run-step-row" data-status="${step.status}">
      <span class="seq">${step.id.replace('step_', '#')}</span>
      <span class="status status-${step.status === 'success' ? 'success' : step.status === 'error' ? 'failure' : 'running'}">${replayStepStatusLabel(step.status)}</span>
      <span class="summary">${step.action}${step.errorCode === undefined ? '' : ` · ${step.errorCode}`}</span>
      <span class="duration">${step.status === 'skipped' ? '未执行' : '已完成'}</span>
    </li>
  `).join('')

  return `
    <main class="panel" data-testid="replay-view">
      <section class="run-summary" data-testid="run-summary">
        <strong>Run ${run.id}</strong>
        <span>来源 ${sourceRecording}</span>
        <span>状态 ${statusLabelText}</span>
        <span data-testid="run-progress">${run.executedSteps}/${run.totalSteps}</span>
        <span>${run.startedAt} · ${(run.durationMs / 1000).toFixed(1)} s</span>
        <span>${notExecutedNote}</span>
        <div class="run-switch" role="group" aria-label="Run 切换">
          <button type="button" data-testid="run-failed" data-replay-run="failed" data-active="${String(selectedId === 'failed')}">failed 15/20</button>
          <button type="button" data-testid="run-completed" data-replay-run="completed" data-active="${String(selectedId === 'completed')}">completed 20/20</button>
        </div>
      </section>
      <div class="report-grid">
        <ol class="run-steps" data-testid="run-step-list">${stepRows}</ol>
        <aside class="evidence-panel" data-testid="evidence-panel">
          <div class="detail-header">失败证据</div>
          <div class="evidence-thumb">assets/step-015.png</div>
          <div><div class="detail-label">stepId</div><div>${run.failedStepId ?? '无'}</div></div>
          <div><div class="detail-label">错误码</div><div>${run.errorCode ?? '无'}</div></div>
          <div><div class="detail-label">说明</div><div>${run.status === 'failed' ? '已停止，未自动重试，原 Recording 未修改。' : '成功 Run 无失败证据。'}</div></div>
        </aside>
      </div>
    </main>
  `
}

export function mountActivityView(
  root: HTMLElement,
  steps: readonly ActivityStep[] = defaultActivityFixture(),
  recordings: readonly RecordingSummary[] = defaultRecordingFixture(),
): void {
  ensureStyle()
  const replayFixtures = defaultReplayRunFixtures()
  const state: ViewState = {
    activeView: 'live',
    filter: 'all',
    selectedStepId: steps[0]?.id,
    selectedRecordingId: recordings[0]?.id,
    replayRequestedId: undefined,
    selectedReplayRunId: 'failed',
  }

  const render = (): void => {
    const main = state.activeView === 'live'
      ? `<main class="panel live-grid" data-testid="live-view">
          <section class="timeline-panel">
            <div class="filters" role="group" aria-label="步骤筛选">${renderFilters(steps, state)}</div>
            <ol class="timeline" data-testid="timeline-list">${renderTimeline(steps, state)}</ol>
          </section>
          <aside class="detail-panel" data-testid="step-detail">${renderDetail(steps, state)}</aside>
        </main>`
      : state.activeView === 'recordings'
        ? renderRecordingsView(recordings, state)
        : renderReplayView(state, replayFixtures)

    root.innerHTML = `
      <div class="activity-shell" data-testid="activity-app">
        <header class="topbar">
          <div class="brand">DSH Record &amp; Replay</div>
          <nav class="tabs" role="tablist" aria-label="活动视图">${renderTabs(state)}</nav>
          <div class="session">Chrome · example.test · 录制中</div>
        </header>
        ${main}
      </div>
    `

    root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
      button.addEventListener('click', () => {
        state.activeView = button.dataset.view as ActivityView
        render()
      })
    })
    root.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        state.filter = button.dataset.filter as ActivityFilter
        render()
      })
    })
    root.querySelectorAll<HTMLElement>('[data-step-id]').forEach((row) => {
      row.addEventListener('click', () => {
        state.selectedStepId = row.dataset.stepId
        render()
      })
    })
    root.querySelectorAll<HTMLElement>('[data-recording-id]').forEach((row) => {
      row.addEventListener('click', () => {
        state.selectedRecordingId = row.dataset.recordingId
        render()
      })
    })
    root.querySelectorAll<HTMLButtonElement>('[data-replay-recording]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        if (button.getAttribute('aria-disabled') === 'true') return
        state.replayRequestedId = button.dataset.replayRecording
        state.activeView = 'replay'
        render()
      })
    })
    root.querySelectorAll<HTMLButtonElement>('[data-replay-run]').forEach((button) => {
      button.addEventListener('click', () => {
        state.selectedReplayRunId = button.dataset.replayRun
        render()
      })
    })

    window.__activityState = {
      cuaActionCount: 0,
      ...(state.selectedStepId === undefined ? {} : { selectedStepId: state.selectedStepId }),
      ...(state.selectedRecordingId === undefined ? {} : { selectedRecordingId: state.selectedRecordingId }),
      ...(state.replayRequestedId === undefined ? {} : { replayRequestedId: state.replayRequestedId }),
      ...(state.selectedReplayRunId === undefined ? {} : { selectedReplayRunId: state.selectedReplayRunId }),
      activeView: state.activeView,
      filter: state.filter,
    }
  }

  render()
}
