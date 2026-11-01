/**
 * 插件侧 Skill runtime（design/backend.md「Host 适配」：`plugin/index.ts` 创建 skill runtime 并注入）。
 *
 * 职责边界：
 * - 把 `FsSkillStore` / `FsSkillCatalog` / `SkillReviewService` / `SkillFeedbackService` 装成
 *   Host 工具需要的端口（`SkillToolPorts` 的六个动作）；
 * - Skill 生成需要「completed Recording + 成功的 Run」两类证据：Recording 来自
 *   `RecordingService.readSteps`，manifest（含 stepsSha256）来自 `RecordingStore.readManifest`，
 *   Run 来自 `FsRunStore.listRuns`；本模块只读，绝不触发浏览器动作；
 * - 所有写入仍由 `skill/` 应用服务负责（草案写 `_drafts/`、安装写 `skills/`），这里不绕过
 *   审查门禁，也不直接拼路径写文件。
 */
import type { RecordingId } from '../core/api.js'
import type { RecordingStore } from '../store/api.js'
import type { ProjectedStep, RecordingService } from '../recording/index.js'
import type { RunRecord } from '../replay/index.js'
import { FsSkillCatalog } from '../skill/catalog.js'
import { readFile } from 'node:fs/promises'
import { SkillFeedbackService, type SkillFeedbackReceipt } from '../skill/feedback.js'
import { publishProjectSkill } from '../skill/publish.js'
import {
  generateSkillDraft,
  type GenerateSkillDraftInput,
  type SkillGenerationSource,
  type SkillRecordingEvidence,
} from '../skill/generator.js'
import type { SkillModelPort } from '../skill/drafting.js'
import type { InstalledSkill, SkillDraft, SkillFeedback } from '../skill/model.js'
import { SkillReviewService, type SkillDraftSummary, type SkillInstallRequest } from '../skill/review.js'
import { FsSkillStore } from '../skill/store.js'
import type { FsRunStore } from './fs-run-store.js'

export interface SkillRuntimeDeps {
  /** Skill 库根：`_drafts/`（草案）与 `skills/`（安装版本）的父目录。 */
  readonly root: string
  /** 工作区根：把已安装 Skill 投影到 `<workspace>/.dsh/skills/` 供 DSH 发现。 */
  readonly workspaceRoot: string
  readonly recordings: RecordingService
  readonly recordingStore: RecordingStore
  readonly runs: FsRunStore
}

/** Host 工具可用的 Skill 动作集合（一一对应 SKILL_HOST_TOOL_NAMES）。 */
export interface SkillRuntime {
  readonly store: FsSkillStore
  readonly catalog: FsSkillCatalog
  generate(input: GenerateSkillDraftInput, model?: SkillModelPort): Promise<SkillDraft>
  review(draftId: string): Promise<SkillDraftSummary>
  install(request: SkillInstallRequest): Promise<InstalledSkill>
  feedback(feedback: SkillFeedback): Promise<SkillFeedbackReceipt>
}

/** 把 Recording/Run 的只读事实投影成生成器的来源证据。 */
class RecordingSkillSource implements SkillGenerationSource {
  constructor(private readonly deps: SkillRuntimeDeps) {}

  async readRecording(recordingId: RecordingId): Promise<SkillRecordingEvidence | undefined> {
    let manifest
    try {
      manifest = await this.deps.recordingStore.readManifest(recordingId)
    } catch {
      // 找不到 Recording 时交给生成器报 RECORDING_INCOMPLETE（IF-1），这里不臆造证据。
      return undefined
    }
    const steps: ProjectedStep[] = []
    for await (const step of this.deps.recordings.readSteps(recordingId)) {
      steps.push(step)
    }
    return {
      recordingId,
      title: manifest.title,
      status: manifest.status,
      ...(manifest.stepsSha256 === undefined ? {} : { sha256: manifest.stepsSha256 }),
      ...(manifest.suppressedCount === undefined || manifest.suppressedCount === 0
        ? {}
        : { suppressedStepCount: manifest.suppressedCount }),
      steps,
    }
  }

  async listRuns(recordingId: RecordingId): Promise<readonly RunRecord[]> {
    return this.deps.runs.listRuns(recordingId)
  }
}

/** 构造工作区级 Skill runtime；同一个 Store 同时服务审查/安装/反馈与索引读取。 */
export function createSkillRuntime(deps: SkillRuntimeDeps): SkillRuntime {
  const store = new FsSkillStore({ root: deps.root })
  const catalog = new FsSkillCatalog({ root: deps.root })
  const review = new SkillReviewService({ store })
  const feedback = new SkillFeedbackService({ store })
  const source = new RecordingSkillSource(deps)

  return {
    store,
    catalog,
    generate: (input, model) => generateSkillDraft(input, {
      source,
      store,
      ...(model === undefined ? {} : { model }),
    }),
    review: draftId => review.review(draftId),
    install: async request => {
      const installed = await review.install(request)
      try {
        const markdown = await readFile(installed.path, 'utf8')
        const projectSkillPath = await publishProjectSkill({
          workspaceRoot: deps.workspaceRoot,
          name: installed.name,
          markdown,
        })
        return projectSkillPath === undefined ? installed : { ...installed, projectSkillPath }
      } catch {
        // 投影失败不回滚库内安装；DSH 发现不到时仍可用 cua_skill_* 工具。
        return installed
      }
    },
    feedback: value => feedback.record(value),
  }
}
