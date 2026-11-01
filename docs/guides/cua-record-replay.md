# Cua Driver 浏览器 Record/Replay 交付指南

本指南汇总 REQ-261030122116-4af4 的交付结论与后续接入方式。

## 交付结论

- Cua Driver-only 路线已实现并通过验收：不使用 `dsh_browser` 执行浏览器动作。
- 已覆盖 Recording、Store、Replay、Host、UI 与 testing/conformance。
- 最终回归：`pnpm exec tsc --noEmit`、`pnpm test`、`pnpm exec playwright test tests/e2e/activity-view.spec.ts --project=chromium` 均 exit 0；真实浏览器 E2E 在 `CUA_E2E=1` 下通过。

## 关键路径

- 实现说明：`docs/projects/PRJ-0001/design/cua-record-replay-technical-implementation.md`
- 验收证据：已随需求材料移出公开树（本地保留）。
- 运行入口：`src/host/index.ts`、`src/client/index.ts`

## 后续接入注意

- 右侧栏面板已挂载（M1.6/M2/M3）；独立 `panel` 进程仍是只读调试入口。
- 右侧栏 webview 未作为 V1 验收载体，需独立验证后再切。
- Native Cua Transport 已接入但**不是默认**：`native` 用 `@trycua/cua-driver` 0.28 跑在独立子进程，要求宿主 bundle 身份是 `com.trycua.driver`；DSH 的身份是 `com.deepseek.dsh`，预检必然失败，因此默认走 `mcp`，`native` 仅作为其他宿主的 opt-in。

## Skill 知识库

REQ-261030190819-2dfd，2026-10-30 验收通过。

- Recording + 成功 Run 可沉淀为可复用 Skill：生成（`cua_skill_generate`）→ 人工审查（`cua_skill_review`）→ 确认安装（`cua_skill_install`）→ 检索/加载（`cua_skill_search` / `cua_skill_load`）→ Run 反馈计数（`cua_skill_feedback`）。
- Skill 库根默认 `.dsh/skill-library`：草案在 `_drafts/`，已安装在 `skills/<site>/<flow>/`（版本只增不删，`versions/v<N>/` 留不可变副本）。
- 安装成功后会把同一份内容投影到 `<workspace>/.dsh/skills/<name>/SKILL.md`，并补 `description` 与 `How to run` 段，供 DSH 自带的 `skill` 目录发现并加载；库内那份仍是权威副本（版本、计数）。
- 安全边界：未确认零写入（`SKILL_NOT_CONFIRMED`）；明文秘密/掩码（`SKILL_SECRET_DETECTED`）、纯坐标（`SKILL_COORDINATE_ONLY`）、缺 Verification（`SKILL_INVALID`）一律拒绝；replay `values` 仅进程内过手。
- `skill.enabled` 默认 false：写族工具返回 `FEATURE_DISABLED`，读族（review/search/load）始终可用；`autoFeedback` 默认 true，Replay 终态自动反哺计数。
- 使用示例与失败码：已随需求材料移出公开树；验收结论：TC-1～TC-10 全绿，全量回归 224 过 / 2 跳过。

## 2026-10-31 现状与已知缺口

### 传输

- 默认 `mcp`（0.38 CLI daemon）；`native` opt-in，DSH 内会因 `bundle_identity` 预检失败回退，不再白付一次握手。
- 断线重连：`CUA_TRANSPORT_DISCONNECTED` / `CUA_TRANSPORT_UNAVAILABLE` 时丢弃缓存客户端，下一次调用重新握手。
- daemon 卡死：`browser_prepare` 返回 `tool_invocation_failed` 时，插件自动执行 `cua-driver stop` 并重试一次 bind（`DSH_CUA_DAEMON_RECOVERY=0` 可关闭）；会杀掉该 daemon 上的所有会话。
- DSH 重启不会重启 Cua daemon，跨重启残留的 pending setup 仍可能触发一次卡死，自动恢复会兜住。

### 浏览器与 profile

- `launch: "existing"` 绑已有窗口；`launch: "isolated"` 起 driver-owned Chromium；`profileName` 复用持久 profile。
- 命名 profile 启动前会修补 `Default/Preferences`：`profile.exit_type=Normal`、`exited_cleanly=true`（不再弹「恢复网页」）、`session.restore_on_startup=1`（会话 cookie 落盘，登录态可跨 daemon 重启）。
- 新登录后建议等 ~30 秒再 release：新写入的 cookie 仍受 Chrome 刷盘周期影响。
- **同窗口新标签跟随**：点击后驱动会在同一原生窗口内重读 active tab（最多 ~2 秒、250ms 间隔），把 Cua 的 `target_id` 与 `tab_id` **成对**替换；后台标签、跨 target/新窗口、刷新失败都保留原 tab，click 仍算成功并在 step summary 写明原因。Cua 每次 bind 查询都会重新 mint target/tab id，不能拿两次查询的 id 混用（否则 `browser_tab_not_found`）。
- 视口外元素：解析优先 `in_viewport`，但驱动不会主动滚动；需要操作视口外元素时先导航/滚动到它。

### 回放

- 只重放 `status: "success"` 的步骤；失败步骤留在 Recording 里做审计，不再重演。
- `TARGET_NOT_FOUND` 有 5 秒 settle 重试（250ms 间隔），解决「导航刚返回、SPA 还没渲染完」。
- `target.index` 按**可见匹配**计数：Cua 的 refs 带 `visibility`（`in_viewport` / `offscreen`），隐藏元素不出现；解析时优先 `in_viewport`，全部 offscreen 才回退。Sauce Demo 的「点击成功但购物车不变」由此解决（原来的 index 命中了视口外的同名按钮）。
- 不做起始状态校验：例如录制时购物车为空、回放时已有商品，流程会因目标消失而失败。

### Skill

- 生成 → 预检 → 确认安装 → 检索/加载 → 反馈全部走通；版本只增不删，安装需 `decision: "confirmed"`。
- `skill.enabled` 默认 `true`（本轮已改），写族工具不再需要显式开启。
- **autoFeedback 已覆盖手动 `cua_replay_start`**：Run 进入终态后，插件按 `sourceRecordings` 找到对应 Skill 并自动反馈（success/failed），幂等由 `runId` 保证；`skill.enabled` 或 `skill.autoFeedback` 关闭时跳过。
- 失败反馈会把 `needs_review` 置 true、`status` 改为 `needs_review`；**后续成功不会自动清除**（只加 success_count 和 last_verified）。恢复方式是按同一 draft 重新安装/重新生成版本，计数会重置为 0。
- Skill 的「Expected final URL」取的是最后一个 navigate 的 URL，若末步是 click，不会记录点击后的落点。

### 斜杠命令

`/record-status`、`/record-launch [profileName]`、`/record-start <title>`、`/record-stop`、`/record-bind <pid> <windowId>`；独立 `commands` 注入，不经过模型。

### 已跑通的真实用例

- Wikipedia 搜索：navigate → setValue(searchbox) → click(Search)，回放 completed。
- Sauce Demo 登录：登录态命名 profile，跨 daemon 重启仍保持会话（`restore_on_startup` 生效）。
- B 站个人空间 → 设置：navigate `space.bilibili.com` → click `设置`，回放 completed；已沉淀为 Skill `bilibili-space-settings`（v1）。失败路径测试后按同一 draft 重装恢复 active，计数归零。

### 未解决 / 风险

1. existing-profile 绑不上用户日常 Chrome：Cua 0.38 要求窗口 AX 里存在英文 `New Tab` 按钮做身份证明，中文 Chrome 必然失败；
2. 跨 target/新窗口的新标签不跟随（只跟同一 `pid/window` 内激活的 tab）；后台打开的新标签也不跟，刷新失败时保留旧 tab（summary 可见）；
3. daemon 卡死需重启 daemon，自动恢复有全局副作用；
4. 独立 `panel` 进程没有回放服务，重跑/移入回收站只在 DSH 挂载下可用；
5. 视口外元素不自动滚动，需要先导航/滚动到其位置。

### 回归入口

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run        # 313 通过 / 2 跳过（2026-11-01）
pnpm build
```

## 2026-11-01 drag 坐标基准与浏览器右键/双击

### drag 的根因：AX frame 是屏幕坐标，drag 要窗口局部截图像素

- `get_window_state` 同时返回 `frame` 与 `screenshot_frame`。实测 1888x1050 窗口 bounds=(0,30)：`AXWindow.frame=(0,30,1888,1050)`、`screenshot_frame=(0,0,…)`；CARD `frame=(25,213)`、`screenshot_frame=(25,183)`——差值正好是窗口原点（标题栏）偏移。
- Cua `drag` 的参数说明是 “window-local screenshot pixels”，回执 summary 也把 window-pixel 加窗口原点换算成 screen。
- 旧实现直接把 AX frame 中心传给 drag，于是每次拖拽都整体偏移 `(window.x, window.y)`。
- 专用 Chrome（pid 5154 / window 16175，1200x800）+ 本地 fixture 实测：
  - 小目标 36x36：截图基准 `(105,250)→(345,250)` → 页面 `dropped=yes down=1 move=20 up=1`；AX 基准 `(145,290)→(385,290)` → `dropped=none down=0`（按下落空）。
  - 大目标 144x95：截图基准同样 drop；所以大目标会掩盖该 bug，小目标才暴露。
- 修复：`CuaDesktopDriver.drag` 重新取一次带截图的快照，用 `screenshot_frame` 中心；没有该字段时用 `window_bounds + screenshot_scale` 折算（Retina）。

### HTML5 drag-and-drop：后台投递被拒，foreground 才完成

- pointer fixture：background 即可（`route: synthetic_events`）。
- HTML5 fixture：background 返回 `background_unavailable` / `reason: drag_and_drop_session`（页面 `dragstart=1, up=0`，drop 不触发）；foreground 重试后 `dropped=html5`。
- 驱动对 `background_unavailable|foreground_required` 自动重试一次 foreground；该重试会短暂前置窗口并移动物理指针。

### 浏览器绑定：drag/右键/双击走 browser_pointer

- 浏览器 drag 不经过坐标：两端 ref 从同一快照解析，`browser_pointer {action:"drag", ref, destination_ref}`；isolated Chrome 实测 `dropped=yes`，HTML5 fixture 实测 `dropped=html5`。
- `click` 映射：左键单击仍走 `browser_click`；`button: "right"` → `browser_pointer right_click`；`count: 2` → `double_click`；`count: 3` 与 right+count>1 明确 `ACTION_UNSUPPORTED`。
- isolated Chrome 实测：`left=0 right=0 dbl=0` → 右键 `right=1` → 双击 `dbl=1 left=2` → 左键 `left=3`。
- `ACTION_SPECS.drag` 已移除 `cuaBrowser: false`，drag 重新进入回放能力表。

## 2026-11-01 新标签跟随（spike 结论）

### Cua 的 tab/target 语义

- bind 模式 `get_browser_state {pid, window_id}` 返回 `tabs` + `target_id`；**每次调用都会重新 mint 一个 session-scoped target_id 和全部 tab_id**。14 次连续轮询里 `target_id` 每次都变，`tab_id` 也每次都变；底层的窗口和 tab 没变。
- 同一次响应里的 `(target_id, tab_id)` 是自洽的：可以重复使用，也可以直接 `observe`/`click`/`navigate`。跨响应混用（旧 target + 新 tab，或新 target + 旧 tab）会被拒：`browser_tab_not_found`。此前“用 pid/window 查询拿到别的 target 的 tab”就是这个原因。
- 点击 `target="_blank"` 后约 0.7 秒新 tab 激活：`tabs` 从 1 条变 2 条，active 指向 `second.html`，旧 tab 仍在列表里且 `active: false`。
- 因此“仅当 `active.target_id === binding.targetId` 才更新”这个判据永远不成立——`target_id` 本来就是每次查询新 mint 的。可验证的“同一个 target”是 **native window（pid/window）+ exact binding route/quality**；跟随动作必须在**同一次响应**里取 `target_id` 和 active `tab_id`，成对替换。
- 只带 `target_id`（不带 `tab_id`）的快照请求会被拒，不能用来枚举 tabs。

### 实现

- `CuaBrowserDriver` 在 click 成功后调用 `followActiveTab`：每 250ms 重读一次同窗口 active tab，最多 2 秒；没有新 tab 时约 500ms 静默后提前结束，避免给普通点击平白加 2 秒。
- 只有 `binding_route`/`binding_quality` 与 bind 时一致、active tab 已变化、且计数增加（新 tab）时才切换；旧 tab 必须仍在 tab 列表里，否则视为跨 target/新窗口并保留原 tab。
- 后台打开的新 tab 不切换；等满 2 秒后保留原 tab。刷新失败不把 click 判失败，只在 step summary 写 `kept current tab: tab refresh failed`。
- 新 tab 刚激活时可能还在 provisional frame：下一次 `observe` 会收到 `browser_route_unavailable` / `Frame ... not found`。驱动会为同窗口重新 mint active pair 并重试 snapshot（≤2 秒），不会把这种瞬时错误抛给回放。
- 同 tab 内导航（`target="_self"`）不重绑，旧 handles 继续有效。
- Fake Cua 覆盖 8 个用例（跟随、激活竞态、provisional frame 恢复、后台 tab、异 target、旧 tab 消失、刷新异常、同 tab 导航）；live 用 isolated Chrome 跑通本地 fixture 和 B 站「热门」（连续 3 次）。

### 证据与回归

- Spike 证据：`docs/spikes/2026-11-01-tab-follow/evidence.json`（14 次轮询的 target/tab 变化、原子 pair 复用、跨 pair 拒绝、B 站候选）。
- Live 证据：`docs/spikes/2026-11-01-tab-follow/live-evidence.json`（fixture 跟随后可点击 second 页按钮；B 站落到 `https://www.bilibili.com/v/popular/all…`，标题「哔哩哔哩热门」）。
- `pnpm exec tsc --noEmit`、`pnpm exec vitest run`（313 通过 / 2 跳过）、`pnpm build` 全绿；插件工具 26 个、0 重名。

### 限制

- 只跟同一 `pid/window` 内激活的 tab；`window.open` 打开的新窗口不跟（刷新范围就是绑定的原生窗口）。
- 后台打开的新 tab 不跟；用户之后手动切过去也不会自动重绑（下一次 click 的 follow 会重新判断）。
- 刷新列表里找不到旧 tab 时不跟（保守地视为跨 target/window）。

## 2026-11-01 浏览器 scroll 与 key 能力边界

### scroll：browser_pointer 必须有 ref 或 x/y

- `browser_pointer { action: "scroll" }` 只有在带 `ref` 或 `x`/`y` 时才执行；两者都不带返回 `tool_invocation_failed`（不是 `ACTION_UNSUPPORTED`），所以「无 target 就省略坐标」不可行。
- 带 `ref`：Cua 先把该 ref 滚进视口，再应用 `delta_x`/`delta_y`；实测从顶部对页面底部按钮滚 `delta_y=900`，按钮从 `offscreen` 变 `in_viewport`。
- 带 `x`/`y`：按视口坐标派发滚轮，`delta` 是 CSS 像素；实测视口中心 `(592,356)` 连续 `delta_y=600` 两次，`scrollY` 从 0 → 600 → 1200。滚动是异步落地的，调用返回后立即读可能还是旧值（首个探针因此误判「x/y 不生效」）。
- 视口尺寸从 `get_browser_state { include_screenshot: true }` 的 `screenshot.viewport_css_width/height` 读取（实测 1185x713 / 1200x713）；驱动每个 binding 只测量一次并缓存到 binding record，之后无 target 的 scroll 不再拉截图。
- `deltaX`/`deltaY` 全为 0 时驱动直接 `INVALID_ARGUMENT`，不发 Cua。`key` 仍保持 `ACTION_UNSUPPORTED`，`ACTION_SPECS.key` 标 `cuaBrowser: false`，能力表不再宣告浏览器按键。
- 单测：`tests/unit/cua/browser-scroll.test.ts`（7 例：target ref 参数、视口中心 + 只测量一次、水平 delta、零 delta、target 未解析、缺视口元数据、key 不发任何动作）；契约测试同步为 `navigate/click/setValue/drag/scroll/assert`。
- Live：`tests/spikes/cua-browser-scroll.test.ts`（本地长页 + `bind({launch:"isolated"})` 的 driver-owned Chromium + 生产 `CuaBrowserDriver`）：targeted scroll 后底部按钮 `offscreen → in_viewport`；无 target 上滚 8 步让顶部输入框 `in_viewport`、下滚 8 步到底部按钮 `in_viewport`（上限 12/16 步），断言全部走语义 `visibility`，不依赖 CDP/焦点；证据 `docs/spikes/2026-11-01-browser-scroll/evidence.json`。`tests/e2e/browser-scroll.spec.ts` 在 `CUA_E2E=1` 时跑该 spike。

### key：Cua 0.38 没有浏览器级按键注入

- 工具目录里没有 `browser_key`；`browser_pointer` 的 action 只有 `hover/right_click/double_click/scroll/drag`。
- `browser_type mode:"keystrokes"` 是逐字符文本输入：`text:"Enter"` 在页面产生 `keydown` `E,n,t,e,r`（值为 `"Enter"`）；`"\t"`/`"\n"` 会分别变成 Tab/Enter 的 keydown，但仅此两个控制字符、且必须给一个可编辑 ref，普通键名（如 `Escape`）会被逐字打出来，也没有修饰键。它不是通用的按键通道，不能据此实现 `key` 动作。
- 原生 `press_key`/`hotkey` 是窗口级工具，后台 tab 收不到（页面 `window.__keys` 为空）；要用桌面绑定（`cua_desktop_press_key`）或把步骤换成 `click`/`assert`（浏览器 `wait` 动作同样未实现）。
- 结论：浏览器 `key` 明确保留 `ACTION_UNSUPPORTED`，README「Replay semantics」已写明。能力表按 launch 分成两张：`CUA_BROWSER_ACTION_KINDS`（无 key）与 `CUA_DESKTOP_ACTION_KINDS`（有 key，无 navigate/wait）；`ReplayOptions.launch` 让 plan 选对表，桌面录制里的 key 仍可回放。

## 桌面能力边界（2026-10-31 spike）

Cua Driver 不只做浏览器：`list_apps` / `list_windows` / `get_window_state`（AX 树 + 截图 + `element_token`）/ `click` / `type_text` / `set_value` / `press_key` / `hotkey` / `verify_state` 都在。本插件当前**只消费浏览器语义层**，桌面是能力缺口而非 Cua 限制。

在 DSH 桌面（Electron，pid 72139 / window 14574）上的实测：

| 操作 | 结果 |
|---|---|
| `get_window_state` | AX 树 199 个元素，含 `AXWebArea`、按钮、输入框、会话列表 |
| `click(element_token)` | 投递成功，`effect: unverifiable` |
| `type_text`（background） | 拒绝：`background_unavailable`（Electron Web 内容没有安全的背景文本通道） |
| `set_value(element_token)` | 成功，值可读回（`zz-spike`），可再清空 |
| `verify_state`（原生 AXWindow） | satisfied；对 Web 内容选择器返回 `unknown`（`untrusted_source`） |
| `press_key` | 成功 |

结论：

- 原生壳层（窗口、菜单、原生对话框）可测，断言用 `verify_state` 只对原生 AX 可信；
- Electron 的 Web 内容：点击能发但效果不可确认，文本输入用 `set_value` 替代，断言改走截图或浏览器层；
- 桌面动作进入插件前需要新动作模型（window + element_token 解析、效果读回、截图证据），且 `element_token` 是快照内的，回放必须按 role/name 重新解析。

已实现 `CuaDesktopDriver`（`src/cua/desktop-driver.ts`）：`observe` / `click` / `setValue` / `pressKey` / `assert` / `screenshot`。live 验证通过：1144 个 AX 元素、点击「搜索会话」、写入/清空搜索框、Esc、断言按钮存在、截图落盘。断言走 **AX 观察**而不是 `verify_state`——Electron 的 Web 内容在 `verify_state` 里是 `untrusted_source`（unknown）；`type_text` 仍不可用（背景通道被拒），文本一律走 `set_value`。尚未接入 Host 工具与 Recording 管线。

## 2026-11-01 「click 返回 success 但页面无反应」根因与投递策略

### 症状

SauceDemo 登录流：`navigate` → 两次 `setValue` → `click(Login)` 返回 success，URL 仍是 `/`；`assert url contains inventory` 失败。字段值写入正确、没有 `Epic sadface` 校验错误。inventory 页的 `Add to cart` 同样「success 但 Remove 不出现」。

### 实测对比（isolated Chrome，每次都是 navigate → 写两个字段 → 点击）

| 投递方式 | 10 次落地 inventory | 说明 |
|---|---|---|
| `browser_click` ref + `input_route=trusted`（原路径，CDP `Input.dispatchMouseEvent`） | **1 / 10** | 第 1 次成功；之后每次都回 `clicked (600, 326)`，页面零事件 |
| `browser_click` ref + `input_route=dom_event`（合成 pointer/mouse/click） | **10 / 10** | 每次 `effect: confirmed`，落地 inventory |

`browser_pointer` 没有 `click` action（只有 `hover` / `right_click` / `double_click` / `scroll` / `drag`），传 `action:"click"` 会被 Cua 以 `tool_invocation_failed` 拒绝——所以「改用 pointer click」不可行，稳定路线是 `dom_event`。

### 根因（不是 ref 失效，也不是 pointer 事件类型）

用 Playwright 另开一条 CDP 连接给同一个 isolated Chrome 挂事件监听（仓库外的临时探针，证据已随需求材料移出公开树（本地保留））：

- 失败那次点击，页面**一个事件都没有**：只有两次 `setValue` 产生的 `focusin`，没有 `pointerdown/mousedown/pointerup/mouseup/click/submit`。也就是说事件根本没到渲染进程，不是「事件到了但 React 没处理」。
- Cua 点击坐标是对的：按钮 rect `x=454..746, y=302..351`，点击点 `(600, 326)`；`document.elementFromPoint(600, 326)` 也是 `#login-button`。
- 用 Playwright 自己的 `page.mouse.click(600, 326)` 复现同样的失败（连续 navigate 两次后开始丢），而 `page.fill` / `Input.insertText` 一直正常——只有鼠标输入丢。
- 同一页面、同一 tab，`dom_event` 点击立即生效（事件 `isTrusted=false`）。
- 换一个**新 tab** 就又正常一次；`Page.bringToFront`、`Emulation.setFocusEmulationEnabled`、新 CDP session、裸 `Input.dispatchMouseEvent` 都救不回来。

真正的原因是**浏览器自己的原生气泡遮挡**：第一次成功登录后，Chrome 密码管理弹出「更改您的密码 / 您刚才使用的密码遭遇了数据泄露」（`secret_sauce` 是已知泄露口令）。这是 Chrome 的原生子窗口，浮在页面中央、正好盖住登录按钮；原生窗口吃掉鼠标输入，于是 CDP 派发的 mouse 事件到不了页面。tab 截图（`get_browser_state include_screenshot`）看不到它，因为截图只有 tab viewport；用 `screencapture -l <windowId>` 截原生窗口就能看到：`evidence/bubble-round2.png`、`evidence/pw-window-2-failed.png`。

这也解释了「第一次手动重试成功、后续都不跳」：气泡是第一次提交后才出现的。

### 投递策略（已实现）

`CuaBrowserDriver` 的左键单击改成**投递后验证**，而不是相信 `status: ok`：

1. trusted 投递（`browser_click` + `input_route=trusted`，真实 CDP 输入，保留 user activation 语义）；
2. 跟随新标签 + 比对点击前后的语义指纹（URL、元素 role/name/value/visibility、`states` 签名）；最多等 1.5 秒；
3. 页面没变 → 用**新快照**重新解析同一个语义 target，再以 `input_route=dom_event` 重投一次（合成 DOM 点击在页面内执行，不经过原生输入路由，气泡挡不住）；
4. 两次都没有任何可观察变化 → `ACTION_UNCONFIRMED`（新错误码），step summary 写明「可能被原生浏览器气泡遮挡」，不再谎报 success；
5. trusted 路线被 Cua 以 `browser_input_trust_unavailable` / `background_unavailable` 拒绝时，直接走 dom_event（同样只重试一次）。

右键/双击不验证、不重试（双击重试等于四次点击）。新标签出现（包含后台 tab）算作已生效，不做二次点击。

### 验证

- 真驱动（`CuaBrowserDriver` + isolated Chrome + SauceDemo）连续 10 次：**10/10 进入 inventory**，其中 9 次走了 dom_event fallback，第 1 次 trusted 直接成功；证据 `evidence/click-fixed-e2e.json`。
- 新增单测 `tests/unit/cua/browser-click-verify.test.ts`（8 例）：trusted 生效不重试、trusted 静默 + dom 生效（断言重试用了更新的 ref）、仅焦点变化不重试、两条路线都无效 → `ACTION_UNCONFIRMED`、trusted 被拒 → 降级、stale ref 不盲目重试、fallback 被拒时透出 `TARGET_STALE`、右键不重试。
- 全量 `pnpm exec vitest run` 321 通过 / 2 跳过（新增 8 例），`tsc --noEmit`、`pnpm build` 全绿。

### 限制

- 指纹是语义快照：只有 canvas/音频/不可见网络请求等「快照外」副作用的点击，可能被多投一次合成点击。录这种动作时应在点击后紧跟断言，或直接使用 `dom_event` 录制来源。
- 拒绝非受信事件的控件（文件选择器、部分安全确认）在原生气泡打开期间仍然无法驱动；此时要先关掉气泡，或用关闭了密码管理的 profile。
- 判断「页面有没有变」最多等 1.5 秒，慢于 1.5 秒才落地的点击会被当成无效并补一次 dom_event（通常仍幂等，但非幂等按钮要留意）。
