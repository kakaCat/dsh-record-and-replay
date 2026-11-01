---
title: 与 open-codex-record-and-replay 的差距审计
date: 2026-11-01
status: analysis
owner: record-replay DRI
scope: dsh-record-and-replay vs ../open-codex-record-and-replay
---

# 与开源参考实现的差距审计

> 参考：`../open-codex-record-and-replay`（commit `bce89dd`，MIT，约 10.7k 行（含逆向脚本），其中实现与测试约 3.9k 行；19 个测试文件）
> 本仓库：`dsh-record-and-replay`（commit `f1d6c31`，约 29.6k 行 `src/`、89 个测试文件）
>
> 本文只描述差异与建议，不评价哪边“更对”。最后一节给出建议的补齐顺序。
>
> **实现状态（2026-11-01 晚）**：P0-1 已落地——`recording.maxDurationSeconds` 自动停、`endReason`、`cancelled` 终态、`cua_record_discard`、启动时 `recoverStore`、录制同意元数据与 `explicit` 门；P0-2 已落地——URL 抑制通道、私密窗口拦截、`suppressed.jsonl`/计数、通用脱敏正则；P1-1 已落地——页脚 live HUD（计时/Stop/Discard）；P1-2 部分落地——`mode: "model"` 模型增强 Summary/Preconditions/Ambiguities + 5 条 prompt id + 模板降级；P0-3 已落地——`cua_record_export` 输出 `session.json`/`events.jsonl`/`suppressed.jsonl`。详见 README「Recording lifecycle」「Privacy」「Live recording HUD」「Session export」「Skill library」。完整 evaluator/memory.md、人工采集等仍未做；开源就绪已收口（README/LICENSE/CONTRIBUTING/SECURITY/CHANGELOG/发布流程/边界检查）。

## 0. 先对齐口径：两者不是同一层产品

参考项目做的是 **“人演示一遍 → 采集全系统事件 → 生成可复用 Skill”**：它有一个 macOS 原生采集器（全局 event tap + AXObserver），记录人点哪里、输入什么、切到哪个窗口、看到什么 AX 树，然后由 LLM 评估器 + prompt library 把事件流蒸馏成 Skill。

本仓库做的是 **“Agent 通过 Cua 工具执行 → 记录动作 → 确定性回放 → 沉淀 Skill”**：录制对象是 `cua_record_action` 这类工具调用，不是人的原始操作。这一点在原需求里是明确的非目标（“不做人工录制”；需求与验收材料已移出公开树）。

| | 参考实现 | 本仓库 |
|---|---|---|
| 要解决的问题 | 人做过一遍的桌面流程，如何变成可复用 Skill | Agent 做过的浏览器/桌面操作，如何被看见、复核、重跑 |
| 采集面 | 全系统：键鼠、窗口、AX、选区、终端 | Cua 工具调用：浏览器语义动作 + 桌面 AX 动作 |
| 主要产物 | `session.json` + `events.jsonl` + `suppressed.jsonl` | `manifest.json` + `steps.jsonl` + `runs/<runId>/` |
| 回放 | 没有确定性回放，交给 Agent 按 Skill 执行 | 确定性语义回放 + 断言 + 失败证据 + 录屏 |
| 控件 | 原生浮层 + 菜单栏（计时/Stop/Discard） | DSH 右栏面板 + 页脚 live HUD + slash 命令 |
| 代码规模 | 约 10.7k 行（含逆向脚本）/ 19 个测试 | 约 29.6k 行 / 89 个测试文件 |

所以“差什么”要分两层看：

1. **同一条产品线内的差距**（同意、时限、隐私、产物格式、控件、知识生成）——这些和“录人还是录 Agent”无关，是应该补的。
2. **采集层的差距**（全局事件、AX 树、人机交互事件）——这是参考项目的核心，但是本仓库当前主动不做的；要不要补是产品决策，不是缺漏修补。

### 0.1 一句话结论

- **最大的差距是采集层**：我们录不到“人”的操作，只能录 Agent 的工具调用；窗口切换、文本输入过程、快捷键、选区、终端、AX 树差异全部没有。
- **第二层是安全与生命周期**：没有录制同意门、没有 30 分钟上限/自动停、没有 `endReason`、没有隐私抑制通道（排除应用/私密浏览/secure input/URL 策略）。
- **第三层是知识生成**：参考项目用 LLM 评估器 + 5 条 prompt 起草；我们只有确定性模板，没有 `describe-activity`、`draft-memory`、`draft-replay-plan` 这类能力。
- **第四层是交付形态**：我们只是 DSH 插件（Cua 的 MCP **client**），不是可被任意宿主消费的 MCP **server**；开源就绪项（LICENSE、社区文件、发布流水线、公开边界、截图、需求材料）已在 2026-11-01 收口，但 git 历史仍需在公开前重写。
- **我们明显领先的部分**：确定性回放引擎、右栏面板、Skill 全生命周期、套件/CLI/JUnit、测试规模。这些不应该为了“对齐”而回退。

---

## 1. 能力对照表

判定：✅ 对齐或等价 · 🟡 部分 · ❌ 缺失 · ⭐ 领先 · ➖ 主动不做/暂不适用。

### 1.1 采集与事件模型

| 能力 | 参考实现 | 本仓库 | 判定 |
|---|---|---|---|
| 人类演示采集 | 全局 `CGEventTap` + `AXObserver`，任意 App | 无；只记录 Agent 的 Cua 工具调用 | ❌ 架构差异 |
| 浏览器语义动作 | 无动作模型，只有原始事件 | `navigate` / `click` / `setValue` / `scroll` / `key` / `drag` / `assert` | ⭐ |
| 桌面动作 | 无（只采集，不执行） | AX `click` / `setValue` / `press_key` / `scroll` / `drag` / `assert` / `screenshot` | 🟡 有动作、无环境事件 |
| 窗口切换 `window.changed` | 有 | 无（只有 `navigate`） | ❌ |
| 文本输入 `keyboard.text_input` | 有，带缓冲与目标元素 | `setValue` 的脱敏值与语义目标 | 🟡 结果等价、过程缺失 |
| 快捷键 `keyboard.shortcut` | 有 | 桌面只有单键 `press_key`；浏览器 `key` 明确不支持 | ❌ |
| 右键菜单 / 选区 / 终端 | `mouse.context_menu` / `selection.changed` / `terminal.value_changed` | 无 | ❌ |
| AX 树 `fullTree` / `diffFromPrevious` | 有 | `cua_record_observe` 有快照，但不落盘、无 diff | ❌ |
| 事件流格式 | `session.started/ended` + 12 类事件 | 只有 `step.started/finished` | 🟡 自有格式，非同一词汇 |

参考实现的事件词汇与嵌套结构见 `../open-codex-record-and-replay/docs/recovered-protocol.md`；采集器实现见 `../open-codex-record-and-replay/native/Sources/RecordReplayNative/main.swift:32`。

### 1.2 生命周期与同意

| 能力 | 参考实现 | 本仓库 | 判定 |
|---|---|---|---|
| 开始前显式同意 | MCP `elicitation/create`，拒绝即不录 | 无；`cua_record_start` 直接开始 | ❌ |
| 单活跃会话 | 有；重复 start 返回同一会话 | 有；`RECORDING_LOCKED` + `idempotencyKey` | ✅ |
| 最长录制时长 | 1800 秒，自动停 | 无上限 | ❌ |
| 结束原因 | `endReason`：`tool_stopped` / `recording_controls_stopped` / `recording_controls_cancelled` / `max_duration` | 只有 `status`（completed/failed/interrupted） | ❌ |
| 丢弃当前录制 | Discard + 一次性确认，不产出 Skill | `cua_record_cancel` 只停 in-flight 操作；stop 一定产出 Recording | 🟡 |
| 崩溃/坏尾恢复 | 未见对应路径 | 有 `recoverStore`（坏尾截断/锁回收/`interrupted`），但只被测试调用，未接入插件启动或 CLI | 🟡 |

本仓库现状依据：`cua_record_start` 在 `src/plugin/index.ts:719`，stop 在 `:746`；单活跃锁在 `src/recording/service.ts:236`；状态枚举在 `src/store/api.ts:92`；manifest 无 `endReason` 字段（`src/store/api.ts:122`）。

> 运营风险：同一进程内只要有一个 `recording` 状态的 Recording，新的 start 就会 `RECORDING_LOCKED`；而 stop 只允许 owner session 调用。Agent 忘了 stop 时，工作区会一直锁到进程重启；重启后 active map 清空，但磁盘上的旧 Recording 仍是 `recording`，此时 stop 会以 `RECORDING_LOCKED`（“active writer owned elsewhere”，`src/recording/service.ts:325`）拒绝，只能走面板回收站或手动跑 `recoverStore`（`src/store/fs/recovery.ts:95`，目前只被测试调用）。参考实现的 30 分钟自动停正是为了避免这个问题。

### 1.3 隐私与抑制

| 能力 | 参考实现 | 本仓库 | 判定 |
|---|---|---|---|
| 落盘前敏感值脱敏 | 全局正则（信用卡 / AWS key / Bearer / API key）+ 敏感键名 + secure input | `setValue` 全掩码 + 敏感键名 + 信用卡/AWS/`sk-` 正则 + `sanitizePublicMessage` | ✅（secure input 不适用：不采集环境事件） |
| 排除应用 | 4 个系统 bundle（WindowManager/ControlCenter/NotificationCenter/LocalAuthentication） | 无 | ➖ 仅全系统采集时需要 |
| 私密浏览检测 | 7 个浏览器的标题表（Brave/Edge/Safari/STP/Firefox/Nightly/DuckDuckGo） | 标题模式识别，bind 时默认拒绝 | 🟡 无 bundle id，仅标题 |
| secure input 抑制 | 有 | 无 | ➖ 不采集环境键盘 |
| URL 策略 | 4 类 disposition：`applicationExcluded` / `privateBrowsingExcluded` / `urlExcluded` / `urlPolicyBlocked` | `deniedUrlPatterns` 子串 + blocked 持续态；无 allowlist | 🟡 核心已覆盖 |
| 抑制通道 | `suppressed.jsonl` + `suppressedEventCount`，与 `events.jsonl` 分离 | `suppressed.jsonl` + `suppressedCount` | ✅ |
| 采集警告 | 浮层里的 warning popover + 已忽略提示 | 面板详情显示计数，无录制中 popover | 🟡 |
| Skill 秘密校验 | 无 | 拒绝明文/掩码/纯坐标，生成前预检 | ⭐ |

参考实现：`../open-codex-record-and-replay/open/privacy-filter.mjs:29`（排除应用）、`:36`（私密浏览表）、`:61`（分类器）；抑制落盘见 `../open-codex-record-and-replay/open/session-store.mjs:87`。

本仓库：`src/recording/redaction.ts:27`（掩码）、`:30`（敏感键名）。

> 注意：我们采集的是 Agent 动作而非全屏事件，所以“排除应用/私密浏览”暂时不是同一风险面；但 **URL 策略、私密会话识别、抑制计数** 仍然有意义——Recording 会持久化 URL、语义目标名（role/name/text）和用户填写的标题，面板还会跨项目展示。

### 1.4 存储与会话产物

| 能力 | 参考实现 | 本仓库 | 判定 |
|---|---|---|---|
| 会话元数据 | `session.json` 五字段（id/startedAt/endedAt/endReason/eventsPath） | `manifest.json` 更丰富（sha256/stepCount/assetRoot/intent/owner…） | ✅ |
| 追加式事件日志 | `events.jsonl` | `steps.jsonl` | ✅ |
| 会话开始/结束事件 | 有 | 无（只有 manifest 时间戳） | 🟡 |
| 抑制日志 | `suppressed.jsonl` | 无 | ❌ |
| 资产与证据 | 无 | `assets/` + `runs/<runId>/evidence/` + `video/replay.webm` | ⭐ |
| 对外导出/互操作 | 无标准导出 | `cua_record_export`：`session.json` + `events.jsonl` + `suppressed.jsonl`（自有格式） | ✅ 自有格式，非参考事件词汇 |

### 1.5 录制控件与 UI

| 能力 | 参考实现 | 本仓库 | 判定 |
|---|---|---|---|
| 录制浮层 | 非激活 `NSPanel`：计时、Stop、Discard、拖动、警告 | 左栏页脚 live badge + Stop/Discard（非原生浮层） | 🟡 |
| 菜单栏状态项 | 有，同一组 Stop/Discard | 无 | ❌ |
| 录制中状态 | 浮层计时 + 状态项 | 页脚计时 + 红点 + 步数 tooltip | ✅ |
| 事后浏览/搜索/统计 | 无 | 跨项目搜索、统计卡、分页、虚拟滚动 | ⭐ |
| 回放/回收站/重命名/键盘导航 | 无 | 有（M3） | ⭐ |

参考实现控件：`../open-codex-record-and-replay/native/Sources/RecordReplayNative/RecordingControls.swift:4`；本仓库面板见 `src/client/panel/`。

### 1.6 知识生成

| 能力 | 参考实现 | 本仓库 | 判定 |
|---|---|---|---|
| 确定性草案 | 有（offline generator） | 有（八章节 Markdown） | ✅ |
| LLM 评估器 | 有（官方契约是 Codex app-server 的 model/list + thread/start + turn/start；开源实现用 `codex exec` 镜像同一结果形状） | one-shot 会话模型增强 Summary/Preconditions/Ambiguities；无 thread/turn | 🟡 |
| Prompt library | 5 条：`describe-activity` / `suggest-next-actions` / `draft-memory` / `draft-replay-plan` / `create-replay-skill` | 5 条 id 已落地；实际调用 drafting prompt | 🟡 |
| `memory.md` | 有（`draft-memory`） | 无（prompt id 已留） | ❌ |
| 审查/安装/版本/索引/反馈 | 只有 draft + materialize | 六工具全生命周期 + 版本 + `needs_review` | ⭐ |
| 发布到宿主技能目录 | `skill-creator` handoff | 投影到 `.dsh/skills/<name>/SKILL.md` | ✅ |
| 参数化与安全校验 | 较弱 | 强（秘密/坐标/Verification） | ⭐ |

参考实现：`../open-codex-record-and-replay/open/codex-evaluator.mjs`、`../open-codex-record-and-replay/open/prompt-library.mjs:1`；本仓库：`src/skill/generator.ts`（确定性、不依赖模型）。

### 1.7 回放与执行

| 能力 | 参考实现 | 本仓库 | 判定 |
|---|---|---|---|
| 确定性回放 | 无 | 有 | ⭐ |
| 语义定位 + 验证 + 断言 | 无 | 有（可见匹配、settle、点击验证、assert） | ⭐ |
| 回放录屏 | 无 | 有（WebM） | ⭐ |
| 套件 / CLI / JUnit | 无 | 有（`cua_test_run`、`dsh-record-replay test`） | ⭐ |

### 1.8 分发与工程

| 能力 | 参考实现 | 本仓库 | 判定 |
|---|---|---|---|
| 通用 MCP server | 有（3 个工具，任意 MCP 宿主可接） | 无；我们是 Cua 的 MCP **client** | ❌ |
| 宿主插件清单 | Codex `plugin.json` + `.mcp.json` | DSH `cordis.patch.yml` + bundle | 🟡 仅 DSH |
| 独立 CLI | 无 | 有 | ⭐ |
| 许可证文件 | 有（MIT） | 无（仅 `package.json` 声明 MIT） | ❌ |
| 社区文件 / 发布流水线 | 无 | 无 | ❌ 双方都缺 |
| 测试规模 | 19 个文件 | 89 个文件 | ⭐ |
| 对等/审计资产 | completion audit、fixture parity、public boundary | 无 | ❌ |
| 公开边界检查 | 有（禁绝对路径/密钥） | 无；7 个被跟踪文件含 `/Users/<user>` | ❌ |

参考实现：`../open-codex-record-and-replay/.codex-plugin/plugin.json`、`../open-codex-record-and-replay/open/mcp-server.mjs`、`../open-codex-record-and-replay/docs/completion-audit.md`、`../open-codex-record-and-replay/reverse/check-public-boundary.mjs`。

---

## 2. 真正值得补的缺口（按优先级）

### P0-1 录制同意 + 时长上限 + 结束原因（✅ 已实现 2026-11-01）

**现状**：`cua_record_start` 直接开始；无 `maxDurationSeconds`；manifest 只有 `status`，没有结束原因；agent 忘 stop 会锁住工作区。

**参考做法**：开始前 `elicitation/create`；`maxDurationSeconds = 1800` 到点自动 `stop("max_duration")`；结束原因落 `session.json`。

**建议实现**：

1. 配置项 `recording.maxDurationSeconds`（默认 1800）、`recording.consent`（`off` / `implicit` / `explicit`）。
2. start 入参增加 `consent: true`（`explicit` 模式下必填）；manifest 写入 `{mode, scope, grantedAt, grantedBy}` 作为审计凭据。
3. 进程内定时器到点调用 stop，reason=`max_duration`。
4. manifest 增加 `endReason: 'tool_stopped' | 'cancelled' | 'max_duration' | 'failed' | 'interrupted'`，Host DTO 与 `cua_record_query` 携带；面板以 `cancelled` 徽标呈现状态。
5. 新增 `cua_record_discard`：把当前 Recording close 为 `cancelled` 并保留现场（不产出 Skill）；真正删除仍走面板回收站。
6. 插件启动时对 workspace store 调用一次 `recoverStore`，把遗留的 `recording` 标 `interrupted` 并回收过期锁（已接线到 `createWorkspaceStoreRuntime`）。

**验收**：超过 N 秒自动停且 `endReason=max_duration`；`explicit` 模式下未传 `consent: true` 的 start 返回 `FORBIDDEN`；discard 后 Recording 为 `cancelled`，不可回放、不生成草案。

### P0-2 隐私抑制层（✅ 已实现 2026-11-01）

**原现状**：只有动作级脱敏；没有 URL 策略、私密会话识别、抑制通道和计数。

**实现**：

1. 配置 `recording.privacy.deniedUrlPatterns`（大小写不敏感子串）；`navigate`、语义目标 URL、`wait`/`assert` URL、drag 端点命中后，该步骤及其后步骤写 `suppressed.jsonl`（只留 stepId/callId/actionKind/reason/at），直到下一次 navigate 到未排除 URL。`allowedUrlPatterns` 仍未做。
2. `launch: "existing"` 时用 bind 返回的窗口标题识别私密窗口（Chrome/Brave/Edge/Safari/Firefox），默认拒绝绑定；`blockPrivateBrowsing: false` 可关闭。
3. `suppressed.jsonl` + manifest `suppressedCount`；Host DTO、`cua_record_query`、面板详情（“已抑制 N 步”）都可见；Skill 生成把它写进 ambiguities。
4. 脱敏正则补齐信用卡、AWS Access Key、`sk-`/`api-` 前缀 key。
5. README 新增「Privacy」；面板详情显示抑制计数。

**验收**：私密窗口绑定被拒；denied URL 的步骤不进入 `steps.jsonl`；计数在面板可见；导出包含 `suppressed.jsonl` 但不含 URL/值。

> 限制：策略只看动作里出现的 URL（无 target 的 click 不带 URL）；一旦 blocked 会持续到下一次允许的 navigate；排除应用清单（WindowManager 等）只在全系统采集时才有意义，当前不做。

### P0-3 会话产物格式与导出（✅ 已实现 2026-11-01）

**原现状**：`manifest.json` + `steps.jsonl` 是本仓库自定义格式，第三方无法直接消费；没有 `session.started/ended`，也没有抑制日志。

**实现**：

- 新增插件工具 `cua_record_export`（只读，不改 Store）：把 terminal Recording 写成独立目录：
  - `session.json`：`format`/`formatVersion`、id、title、status、startedAt/endedAt、`endReason`、`eventsPath`、可选 `suppressedEventsPath`/`suppressedCount`、`stepsSha256`、consent、driver/browser；
  - `events.jsonl`：`session.started` / `agent.action` / `session.ended`；`agent.action` 保留我们的 action 形状，不伪造 `window.changed`/`mouse.click`；
  - `suppressed.jsonl`：有抑制步骤时原样复制（只含 stepId/callId/actionKind/reason/at）。
- 默认落到 `<store>/exports/<recordingId>/session`；`destination` 必须是 workspace-relative；先写 sibling staging 再 rename，目标已存在直接拒绝。
- 只允许导出本 session 拥有的 terminal Recording；active 返回 `INVALID_ARGUMENT`。

**未做**：面板没有“导出”按钮/状态展示；导出格式是自有格式，不是参考项目的事件词汇。

**验收**：导出目录可被独立脚本读取；导出不改变 Store、不影响回放；suppressed 内容不含 URL/值。

### P1-1 录制中 HUD / 状态可见（✅ 已实现 2026-11-01）

**原现状**：只有事后面板；录制中看不到计时，也没有一键停止/丢弃。

**实现**：

- 左栏页脚 `录制回放` 入口在录制中显示 **录制中 mm:ss** + 脉冲红点，tooltip 带标题与步数；
- 宽态下增加 Stop / Discard 图标按钮；Discard 需 4 秒内二次点击确认，保留目录为 `cancelled`；
- HUD 每秒轮询 `GET /api/record-replay/active?root=<会话工作区>`，只扫描当前工作区；无会话根时回退到全部项目；
- 新增 `POST /stop` / `POST /discard` 路由；Host 从 manifest 的 `ownerSessionId` 派生 principal，不伪造归属；`capabilities.control` 标识可用性，独立 panel 返回 503 `PANEL_CONTROL_UNAVAILABLE`。

**验收**：录制开始后 1 秒内出现计时；Stop 后徽标消失、状态为 completed；Discard 后为 cancelled；独立 panel 不提供控制。

### P1-2 LLM 起草（🟡 部分实现 2026-11-01）

**原现状**：`cua_skill_generate` 是确定性模板，能保证结构，但不会“理解”这次操作想干什么。

**已实现**：

- `cua_skill_generate` 增加 `mode: "template" | "model"`（默认 template）。
- model 模式通过 DSH 已挂载的 `llm` 服务、使用**当前会话的 provider/model**做一次 one-shot 调用；不发明路由、不读凭证。
- 模型只增强 Summary / Preconditions / Ambiguities；步骤、语义目标、Inputs、Verification、Provenance 仍由确定性生成器产出。
- 严格 JSON 解析 + `skill/security.ts` 校验；畸形、明文秘密、坐标或没有模型路由时回落模板，并把原因写进 `ambiguities`。
- 参考项目的 5 条 prompt id 已在 `src/skill/drafting.ts` 落地（`describe-activity` / `suggest-next-actions` / `draft-memory` / `draft-replay-plan` / `create-replay-skill`）。

**未做**：完整 evaluator（app-server thread/turn）、`memory.md` 产物、把整份 replay plan 交给模型重写。

**验收**：model 模式能生成带自然语言 Summary/Preconditions/Ambiguities 的草案；无模型/失败时模板仍可用；秘密/坐标仍被拒。

### P1-3 事件词汇扩展（仅当人工采集进入范围）

需要补：`window.changed`、`keyboard.text_input`（带缓冲）、`keyboard.shortcut`、`selection.changed`、`terminal.value_changed`、`mouse.context_menu`、AX `fullTree/diffFromPrevious`。这些与 P2-1 绑定，单独做没有意义。

### P2-1 人工演示采集（大工程，需产品决策）

参考项目的核心：全局 event tap + AXObserver + 原生 helper + Accessibility/Input Monitoring 权限 + 隐私过滤 + 30 分钟上限。

- 工作量：2–3 周起（原生 + 权限 + 隐私 + 事件 schema + 测试）。
- 前置：P0-1/P0-2 必须先做完；否则采集面一大，隐私和同意就是硬伤。
- 如果做，建议新建独立需求与模块（例如 `capture/`），不要塞进现有 `recording/`。

### P2-2 可移植的 MCP server（依赖 P2-1）

参考项目的 MCP server 之所以可移植，是因为它采的是“人”的操作，和宿主无关。我们录的是 DSH Agent 的工具调用，换一个宿主就没有 `cua_record_action` 产生步骤。因此：

- 若不做 P2-1：通用 MCP server 只能暴露“查询/回放已有 Recording”，价值有限；
- 若做 P2-1：再补 3 工具 MCP server（start/status/stop）+ 宿主插件清单才有意义。

### P2-3 对等/边界验证资产

参考项目有 completion audit、fixture parity、public boundary check、fresh-clone 验证。建议：

- 增加 `docs/analysis/` 的对照矩阵（本文）；
- 增加 `scripts/check-public-boundary.mjs`：禁止 `/Users/<name>`、密钥、真实凭据进入被跟踪文件；
- CI 增加一次“干净 clone + 安装 + 测试 + build”；
- 修掉现有泄漏（见 §4）。

---

## 3. 我们领先、不要为了“对齐”丢掉的部分

1. **确定性回放**：语义定位、可见匹配、settle 重试、点击验证、断言、失败证据、录屏。参考项目没有回放引擎。
2. **面板**：跨项目搜索、统计、分页、虚拟滚动、回收站、重命名、键盘导航。
3. **Skill 全生命周期**：草案 → 预检 → 人工确认 → 安装 → 版本 → 索引 → 反馈 → 投影到 `.dsh/skills`。参考项目只到 draft/materialize。
4. **套件与 CLI**：`cua_test_run`、`dsh-record-replay test`、JUnit、失败继续、超时。
5. **测试规模**：89 个测试文件，覆盖 driver/store/replay/panel/skill/CLI；参考项目 19 个。
6. **绑定与登录态**：`existing` / `isolated` / 命名 profile / `desktop` 四种绑定，登录态可跨 daemon 重启；参考项目没有浏览器绑定概念。
7. **录制意图**：`intent` 字段与面板展示，让 Recording 自带“为什么录”；参考项目的 session 没有等价字段。

---

## 4. 开源仓库就绪度清单（2026-11-01 收口）

| 项 | 状态 | 说明 |
|---|---|---|
| `LICENSE` 文件 | ✅ | 根目录 MIT LICENSE |
| `CONTRIBUTING.md` | ✅ | 开发环境、macOS 权限、测试入口、PR 清单 |
| `SECURITY.md` | ✅ | 私密上报、Cua 权限、录制数据与脱敏边界 |
| `CHANGELOG.md` | ✅ | 0.0.2 变更记录 |
| `CODE_OF_CONDUCT.md` | ✅ | Contributor Covenant 2.1 精简版 |
| Issue / PR 模板 | ✅ | bug/feature forms + PR checklist |
| `package.json` 元数据 | ✅ | repository/homepage/bugs/author/keywords/publishConfig |
| 发布流水线 | ✅ | `.github/workflows/release.yml`：tag → 校验 → npm publish --provenance |
| CI 覆盖 | ✅ | typecheck + vitest + build + public-boundary + Playwright activity-view e2e |
| 公开边界 | ✅ | `scripts/check-public-boundary.mjs` + CI；工作树中的个人路径已清理 |
| 需求/验收材料 | ✅ | 整个 `docs/requirements/` 已移出公开树（本地 `tmp/private-requirements/`） |
| git 历史 | 🟡 | 旧提交仍含路径/截图；`pnpm check:history` 扫描，重写配方见 `docs/guides/public-release.md` |
| 截图脱敏 | ✅ | 含真实工作区/账号/视频的 21 张截图已移出公开树，文档标注“本地证据” |
| 协议/格式文档 | 🟡 | README 有 session export 格式；仍缺独立、版本化的 Recording 规范 |
| 文档时效 | ✅ | “UI 未接/尚未实现”等过期表述已修 |

**个人路径清理**：17 个文件中的 `/Users/<user>`、`/Volumes/<volume>`、主机名/终端标题已替换为
`/Users/<user>`、`/Volumes/work`、`<host>` 等占位符；`m0-cua-collect/manifest.json` 的
`files[].bytes/sha256` 已按新内容重算，`scripts/check-public-boundary.mjs` 在 CI 中兜底。

> 注意：这只清理了**工作树**。要让公开仓库不带历史泄漏，发布前必须重写 git 历史
>（例如 `git filter-repo`）或从一个干净的 squash 提交重建仓库。

**已确认的过期文档**（均已修）：

- `README.md:521`：“UI is not part of the DSH plugin bundle yet.” —— 面板已经挂载。
- `docs/guides/cua-record-replay.md:19`：“UI 仍是静态客户端 fixture。” —— 同上；同文件 `:81` 还有一句“UI 仍是静态 fixture，未接 Host Remote”。
- `docs/projects/PRJ-0001/design/cua-record-replay-technical-implementation.md:14`：“当前仓库尚未实现这些模块。” —— 已实现。
- `docs/knowledge/code-map.md`：生成物为空（0 个符号），应重新生成或删除。

**命名**：公开仓库与 npm 包均为 `dsh-record-and-replay`；插件 id 与 CLI 命令保留 `dsh-record-replay`（CLI 另有 `dsh-record-and-replay` 别名），存储目录仍是 `.dsh/record-replay`。

---

## 5. 建议顺序

| 阶段 | 内容 | 预估 |
|---|---|---|
| M1 | P0-1 同意/时限/`endReason`/discard；P0-3 导出；修个人路径与过期文档；补 LICENSE | 3–5 天 |
| M2 | P0-2 隐私抑制（URL/私密会话/suppressed 计数）；P1-1 录制 HUD | 3–5 天 |
| M3 | P1-2 LLM 起草（prompt library + memory.md + 模板降级） | 3–5 天 |
| M4 | 开源发布：社区文件、元数据、release workflow、边界检查、截图审查 | 2–3 天 |
| M5（可选） | P2-1 人工演示采集（独立需求/模块）+ P2-2 通用 MCP | 2–3 周起 |

如果只做一件事：先做 **P0-1**。它是安全底线，也是当前最容易咬人的运营问题（忘 stop 锁工作区）。

---

## 6. 证据索引

| 结论 | 证据 |
|---|---|
| 参考项目是“人演示 → Skill” | `../open-codex-record-and-replay/README.md`；`docs/recovered-protocol.md` |
| 参考项目 30 分钟自动停 | `../open-codex-record-and-replay/open/session-store.mjs:15` |
| 参考项目开始前同意 | `../open-codex-record-and-replay/open/mcp-server.mjs:149` |
| 参考项目抑制通道 | `../open-codex-record-and-replay/open/session-store.mjs:87`；`open/privacy-filter.mjs:29` |
| 参考项目 LLM 评估器 | `../open-codex-record-and-replay/open/codex-evaluator.mjs` |
| 参考项目 prompt library | `../open-codex-record-and-replay/open/prompt-library.mjs:1` |
| 参考项目原生控件 | `../open-codex-record-and-replay/native/Sources/RecordReplayNative/RecordingControls.swift:4` |
| 本仓库同意/时限（P0-1 已实现） | `src/host/config.ts`（maxDurationSeconds/consent）；`src/recording/service.ts`（scheduleAutoStop/discard）；`src/plugin/index.ts`（assertRecordingConsent/cua_record_discard） |
| 本仓库 endReason（P0-1 已实现） | `src/store/api.ts`（EndReason）；`src/store/fs/jsonl-store.ts`（close）；`src/bootstrap/runtime.ts`（recoverStore） |
| 本仓库隐私抑制（P0-2 已实现） | `src/privacy/policy.ts`；`src/recording/service.ts`；`src/store/fs/jsonl-store.ts`（appendSuppressed） |
| 本仓库私密窗口拦截（P0-2 已实现） | `src/cua/browser-driver.ts`（binding.title）；`src/host/service.ts`（bind check） |
| 本仓库脱敏范围 | `src/recording/redaction.ts:27` |
| 本仓库确定性草案 | `src/skill/generator.ts` |
| 本仓库 Skill 生命周期 | `src/host/tools.ts:539` 起 |
| 本仓库 LICENSE | 根目录 `LICENSE`（MIT），CI 的 public-boundary 检查已接入 |

---

## 7. 变更历史

- 2026-11-01：首版。审计对象 `open-codex-record-and-replay@bce89dd` 与 `dsh-record-and-replay@f1d6c31`。
