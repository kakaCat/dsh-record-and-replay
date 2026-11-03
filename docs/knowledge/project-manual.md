# 项目说明书：Cua Driver 浏览器 Record/Replay

本项目实现 DSH 侧的 Cua Driver-only 浏览器录制与回放基线：Agent 通过 Host 工具操作 Chrome/Edge，录制动作、脱敏落盘，再对 completed Recording 做语义重放。V1 明确不使用 `dsh_browser` 执行链路；Cua Native Transport 已实现（独立子进程 + 崩溃隔离），但因宿主身份限制默认走 MCP。

## 当前认知

- 运行基线：macOS、Node 22、Cua Driver 0.38.0、Chrome/Edge；默认持久 MCP 连接，`native` 为 opt-in。
- 核心模块：`src/core`、`src/cua`（client / mcp / worker / native-host / profile-hygiene / daemon-recovery）、`src/driver`、`src/host`、`src/plugin`（tools + slash commands）、`src/recording`、`src/skill`、`src/store`、`src/replay`、`src/client`、`src/testing`。
- 契约单一来源：`src/core/contracts.ts` 定义 `LAUNCH_MODES`、`ACTION_SPECS`、`TARGET_FIELD_SCHEMAS`、`WINDOW_TARGET_FIELD_SCHEMAS`；bind/replay/套件 的 JSON Schema、handler 白名单校验、driver 能力表都由这些常量派生。新增 launch 模式、动作 kind 或目标字段时只改这里，schema/校验/能力表自动跟随。
- 存储布局：`.dsh/record-replay/recordings/<recordingId>/{manifest.json,steps.jsonl,runs/<runId>/}`；Skill 在 `.dsh/skill-library/`。
- 回放边界：只执行 completed Recording 且只重放成功步骤；`TARGET_NOT_FOUND` 有 5 秒 settle；来源 sha256 不变；写动作发送后不自动重试。
- 定位：`target.index` 按可见匹配计数，优先 `in_viewport`（Cua refs 带 `visibility`），全部 offscreen 才回退；驱动不自动滚动。
- 登录态：`launch: isolated` + `profileName` 持久 profile，修补 `exit_type` 与 `restore_on_startup`，session cookie 可跨 daemon 重启。
- 会话导出：`cua_record_export` 把 terminal Recording 写成 `session.json` + `events.jsonl`（session.started/agent.action/session.ended）+ `suppressed.jsonl`，默认 `<store>/exports/<recordingId>/session`；只读、staging+rename、目标必须不存在；不伪造人类事件词汇。
- Skill 模型起草：`cua_skill_generate` 的 `mode: "model"` 经 DSH `llm` 服务用当前会话路由做 one-shot 增强（仅 Summary/Preconditions/Ambiguities），严格 JSON + 安全检查，失败回落模板；5 条 prompt id 在 `src/skill/drafting.ts`，完整 evaluator/memory.md 未做。
- 录制中 HUD：左栏页脚 `录制回放` 入口显示 `录制中 mm:ss` + 红点；宽态提供 Stop/Discard（丢弃需二次确认）；HUD 每秒轮询 `/api/record-replay/active?root=<会话工作区>`，Stop/Discard 走 `/stop` `/discard`，principal 由 manifest 的 `ownerSessionId` 派生。
- 隐私抑制：`recording.privacy.deniedUrlPatterns` 命中后步骤写入 `suppressed.jsonl`（只留 stepId/callId/actionKind/reason/at），并保持 blocked 直到下一次允许的 navigate；`blockPrivateBrowsing` 默认拒绝私密窗口绑定；`suppressedCount` 在 Host DTO、`cua_record_query`、面板详情和 Skill ambiguities 可见。
- 录制生命周期：`recording.maxDurationSeconds`（默认 1800）到点自动以 `max_duration` 收口；`cua_record_discard` 置 `cancelled`（保留现场、不可回放/生成 Skill）；启动时 `recoverStore` 把遗留 `recording` 标 `interrupted` 并回收过期锁；`recording.consent`（off/implicit/explicit）记录同意元数据。
- Skill 反馈：手动 `cua_replay_start` 的终态会按 `sourceRecordings` 自动反哺（幂等）；失败置 `needs_review`，后续成功不会清除，只能重新安装/生成版本（计数重置为 0）。
- Skill 可执行：安装后把正文投影到 `<workspace>/.dsh/skills/<name>/SKILL.md`（补 `description`、`How to run`），DSH 自带的 `skill-filesystem` 会实时发现，`skill` 工具可直接加载；库内 `.dsh/skill-library` 仍是权威副本。执行依赖模型按正文调用 `cua_record_*`，不是确定性程序。
- 拖拽坐标：Cua `drag` 收窗口局部截图像素，AX `frame` 是屏幕坐标；桌面 drag 必须用同一次截图快照的 `screenshot_frame`（缺字段时 `window_bounds + screenshot_scale` 折算），否则整体偏移窗口原点。浏览器绑定 drag 走 `browser_pointer` 的 ref/destination_ref，不用坐标。HTML5 DnD 需 foreground，驱动遇到 `background_unavailable` 自动重试一次。
- 浏览器点击：左键单击 `browser_click`；右键/双击由 `browser_pointer` 的 `right_click`/`double_click` 承担（count 3 或右键多击明确拒绝）。
- 浏览器滚动：`scroll` → `browser_pointer { action:"scroll" }`；有 target 用 ref（Cua 先滚进视口再加 delta），无 target 用视口中心 x/y（视口尺寸取 `get_browser_state include_screenshot` 的 `viewport_css_*`，每 binding 只测一次）。
- 浏览器按键：Cua 0.38 无 browser 级按键工具（`browser_pointer` 只有指针手势，`browser_type keystrokes` 是逐字符文本，`press_key/hotkey` 是窗口级），`key` 在浏览器绑定保持 `ACTION_UNSUPPORTED`，能力表 `cuaBrowser: false`；桌面绑定可用 `cua_desktop_press_key` 替代。
- 新标签跟随：click 后在同一 pid/window 内重读 active tab（≤2 秒 / 250ms），把 Cua 的 `target_id` 与 `tab_id` 成对替换；Cua 每次 bind 查询都会重新 mint 这两个 handle，跨响应混用会 `browser_tab_not_found`。后台 tab、跨 target/新窗口、刷新失败保留原 tab，click 仍成功并在 step summary 说明。不能按 `active.target_id === binding.targetId` 判断——该 id 每次查询都变。新 tab 的 provisional frame 会让下一次 observe 报 `browser_route_unavailable`，驱动重 mint active pair 后重试。
- 已知限制：右栏面板已挂载，但独立 `panel` 进程是只读调试入口；existing-profile 绑不上中文 Chrome（Cua 的 New Tab 证明）；只跟随同窗口内激活的新标签（新窗口/后台标签不跟）；断言/点击不会自动把视口外元素滚进来（需要显式 `scroll`）；浏览器 `key` 不支持；daemon 卡死需重启（插件自动恢复一次）；foreground drag 会短暂前置窗口并移动物理指针。
- 详见 `docs/guides/cua-record-replay.md` 的「2026-10-31 现状与已知缺口」「2026-11-01 drag 坐标基准与浏览器右键/双击」「2026-11-01 新标签跟随」「2026-11-01 浏览器 scroll 与 key 能力边界」。spike 证据在 `docs/spikes/2026-11-01-tab-follow/`、`docs/spikes/2026-11-01-browser-scroll/`。

## 验证入口

```text
pnpm exec tsc --noEmit
pnpm test
pnpm exec playwright test tests/e2e/activity-view.spec.ts --project=chromium
CUA_E2E=1 pnpm test -- tests/e2e/cua-browser.spec.ts
```
