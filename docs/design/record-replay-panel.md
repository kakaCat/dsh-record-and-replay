# 录制/回放全局面板设计（v0.1）

## 1. 定位

DSH 全局管理面板，**不属于某个会话**：

- 入口：DSH 全局侧栏 / 设置页的一个独立页签；
- 数据：跨项目（工作区）的 `.dsh/record-replay`；
- 首版只读：浏览、搜索、播放视频、查看 Run 详情；写操作（重跑/删除/归类）放二期。

## 2. 技术栈（必须用框架）

| 层 | 选择 | 理由 |
|---|---|---|
| 框架 | **React 19 + TypeScript** | 与 DSH Web 客户端一致，生态成熟 |
| 构建 | **Vite**（client 插件独立 bundle） | DSH client plugin 常规做法，HMR 友好 |
| 组件库 | **shadcn/ui（Radix UI + Tailwind CSS）** | 可访问性完善、样式可控、组件源码可改 |
| 数据请求 | **TanStack Query** | 缓存、失效、分页、错误重试标准化 |
| 列表虚拟化 | **TanStack Virtual** | 录制多时性能稳定 |
| 状态 | **Zustand**（仅 UI 状态） | 选中项目/分类/场景、搜索词；服务端状态不重复存 |
| 路由 | 无路由，面板内 view state | 减少依赖；若未来要深链接再加 |
| 视频 | 原生 `<video>` + 自定义控件 | WebM/MP4 足够，避免引入播放器库 |
| 表格/树 | shadcn 的 Table + 自绘 Tree（Radix Collapsible） | 层级需要树形交互 |

> 备选：Ant Design（表格/树开箱即用，但包大、风格与 DSH 差异大）。除非后续需要复杂表格，否则不用。

### CSS 框架候选

| 方案 | 特点 | 结论 |
|---|---|---|
| **Tailwind CSS v4** | 原子类 + CSS 变量主题，shadcn/ui 默认搭配 | 采用 |
| CSS Modules / vanilla-extract | 组件级作用域，类型安全 | 备选 |
| Panda CSS | 编译期、token 驱动 | 有设计系统时备选 |
| UnoCSS | 原子化、构建快 | 备选 |
| Sass/SCSS + BEM | 传统样板多 | 不用 |
| DaisyUI | Tailwind 预置组件 | 备选 |

原则：**若 DSH 客户端插件自带组件/设计 token，优先复用**；Tailwind 只做布局与少量样式，主题色走 CSS 变量，保证深浅色与主应用一致。

### 其他层选型

| 维度 | 选择 |
|---|---|
| 无头组件 | Radix UI（shadcn 基于它） |
| 数据请求 | TanStack Query |
| 长列表 | TanStack Virtual |
| 表格（M2） | TanStack Table |
| 表单（M3） | react-hook-form + zod |
| 状态 | Zustand |
| 图标 | lucide-react |
| 测试 | Vitest + Testing Library + Playwright（面板 e2e） |

## 3. 信息架构

```
系统级
├─ 项目列表（DSH workspaces + 最近打开的自定义目录）
│   └─ 项目
│       ├─ 分类（默认按 site 自动生成，可改名）
│       │   └─ 场景（可空；空则归入「未分组」）
│       │       └─ Recording（标题、步骤数、状态、时间）
│       │           └─ Runs（状态、耗时、错误码、createdAt）
│       │               └─ 视频（webm/mp4，内嵌播放）
│       └─ 全局搜索（跨分类/场景，按标题/recordingId/Run 状态）
└─ 统计卡片：录制数、Run 数、失败率、视频占用（复用 video-usage 逻辑）
```

三层：**分类 → 场景 → Recording**；场景可空，避免空壳目录。

## 4. 数据模型（项目内索引）

`.dsh/record-replay/index.json`：

```json
{
  "version": 1,
  "categories": [{ "id": "bilibili", "name": "B站", "site": "bilibili" }],
  "scenarios": [{ "id": "arknights-anniv", "categoryId": "bilibili", "name": "明日方舟周年庆" }],
  "assignments": { "rec_xxx": { "scenarioId": "arknights-anniv" } }
}
```

- 索引缺失/损坏：按 recording 的 `site` 自动重建，不阻塞浏览；
- 只读接口不写索引；写接口（改名/归类）二期再做，带文件锁与原子写。

## 5. 接口（Host 侧）

新增一个只读端口，供面板查询：

```
GET /panel/projects                 → [{ root, name, lastOpenedAt }]
GET /panel/project?root=…           → { categories, scenarios, recordings, stats }
GET /panel/recording?root=&id=…     → { manifest, runs: [{ runId,status,errorCode,durationMs,videoPath }] }
GET /panel/video?runId=…            → 视频文件（范围请求，供 <video> 播放）
GET /panel/search?q=…&root=…        → 匹配的 recordings/runs
```

- 数据来源：扫描 `<root>/.dsh/record-replay/recordings/*/manifest.json` + `runs/*/run.json`；
- 结果分页（录制定位数后按 mtime）；
- 路径校验：只允许白名单根目录（workspace + 用户显式添加），防目录穿越；
- 视频走 Host 静态文件接口，不直接暴露文件系统路径。

## 6. 页面布局

```
┌────────────────────────────────────────────────────────┐
│ 顶部：项目选择器 ▾ | 搜索框 | 统计（录制/Run/失败率/占用）│
├───────────────┬────────────────────────────────────────┤
│ 左栏：树        │ 主区：Recording 详情 / Run 列表 / 视频  │
│ ▾ B站          │  标题、状态、步骤数、时间               │
│   ▾ 明日方舟…  │  Runs 表格（状态/耗时/错误码/时间）     │
│     · 搜索     │  选中 Run → 视频播放器 + 错误详情       │
│   · 未分组     │                                        │
└───────────────┴────────────────────────────────────────┘
```

- 空场景：「未分组」虚拟节点；
- 失败 Run 标红，点开显示 `errorCode` 与失败步骤；
- 视频懒加载（选中 Run 才请求），支持下载。

## 7. 里程碑

1. **M1 只读浏览**：项目选择、树、Recording 列表、Run 列表、视频播放；
2. **M2 搜索与统计**：跨项目搜索、统计卡片、视频占用；
3. **M3 操作**：重跑、归类/改名、删除（带确认）；
4. **M4 体验**：键盘导航、深链接、空态/骨架屏。

## 8. 非目标

- 不做录制编辑（步骤修改）；
- 不做多用户/权限（DSH 本机单用户）；
- 不在首版做“新建录制”（仍走会话内的 `/record-start`）。

## 9. M1 实现说明（2026-11-01）

M1（只读浏览）按本设计落地为**独立 client 入口**，不改 Host 工具表（仍为 26 个工具）：

- Host 只读端口：`src/panel/`（`projects` / `project` / `recording` / `video` / `search`，Range + HEAD）；
- 客户端：`src/client/panel/`，Vite 构建到 `dist/panel/`，由 `dsh-record-replay panel` 启动的
  面板服务器同源提供；API 与静态资源都挂在 `/panel/` 下；
- `index.json` 缺失/损坏/缺站点分类时在内存重建，M1 不写索引、不写 `.dsh/`；
- 路径白名单 = 当前目录 + `--root` + `~/.dsh/storages/workspace.json` 中的 DSH 工作区；
  请求 root 先 realpath 再精确匹配，recording/run id 先过 Core 正则，视频按 `runId`
  在 Run 目录内解析并做 symlink containment。

**与设计的偏差 / M1 未覆盖**：

- 设计入口是「DSH 全局侧栏 / 设置页的一个独立页签」；M1 交付时误判为「宿主侧还没有可注册
  全局页签的 client plugin 挂载点」，先用独立 `/panel/` 页面与 `panel` 命令验证了数据层。
  **该偏差已在 M1.5 修正**：DSH 0.2.1 的 `main` + `sidebar.panellist` 槽位就是官方全局页
  入口，见 §10。
- 设计 §5 的「结果分页」尚未实现（当前项目规模一次扫描返回；列表用 TanStack Virtual
  保证长列表渲染）；写操作（重跑/删除/归类）、深链接、键盘导航属于 M2/M3/M4。

## 10. M1.5：挂载到 DSH 全局界面（2026-11-01）

### 10.1 调研结论：DSH 客户端插件机制

本机桌面版 DSH 0.2.1-rc.5（`/Applications/DeepSeek Harness.app`）的客户端插件链路如下：

| 层 | 机制 | 证据 |
|---|---|---|
| 包声明 | `package.json` 的 `dsh.client = { platform: "web", inject, external, immediately }`，并要求 `exports["./client"]` 指向浏览器 bundle | `@deepseek-ai/dsh-client-modules/lib/index.js` 的 `parseDshClient` / `clientExportOf` |
| 代码到达 | 宿主把 bundle 注入为 `window.__ModuleLoader__.load({ id, factory })`；`factory(require)` 在首次 materialize 时执行，React 等由 shell 的冻结模块表提供 | `dsh-client-modules` README + `dsh-web-frontend` 的 `PLATFORM_MODULES`（含 `react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/dsh-client-ui-slots`） |
| 全局页面 | 在 `main`（keyed slot）注册 `key`，在 `sidebar.panellist` 注册同名 `id`；`ctx.layout.selectPanel(id)` 切换主区 | `@deepseek-ai/dsh-client-ui-layout`、`@deepseek-ai/dsh-client-ui-sidebar`、`@deepseek-ai/dsh-client-ui-plugin-manager` |
| 数据通道 | Host 侧 `ctx.inject(['connection'], c => c.connection.fetch.register({ path, methods, requestBody, fetch }))`，handler 是 Web Fetch API；路由位于 DSH 同源、认证围栏内 | `@deepseek-ai/dsh-context-bar` 的 `/api/context-bar.ui`；`@deepseek-ai/dsh-client-ui-deliverables` 的 `ctx.connection.fetch.register` |
| 参考实现 | `dsh-context-bar`（dock + 右栏）、`dsh-better-sidebar`（`settings.section` + 自带 sidebar 服务） | profile 中已加载的同机插件 |

因此**可行**：无需独立端口，也不需要 DSH 提供额外 API。

### 10.2 采用方案

```
DSH 浏览器客户端
├─ sidebar.panellist: id=record-replay  → 左侧栏「录制回放」图标
└─ main:              key=record-replay → src/client/plugin/index.tsx → PanelApp
        │
        └─ same-origin fetch /api/record-replay/{projects,project,recording,search,video}
                │  Host connection.fetch（认证围栏内，无 CORS、无第二端口）
                └─ PanelService（M1 的只读扫描层，未改数据语义）
```

实现文件：

| 文件 | 作用 |
|---|---|
| `src/panel/fetch-api.ts` | 把 M1 的 5 个只读端点表达为 Fetch API `Response`；视频支持 Range/HEAD/416；错误映射沿用 `PanelError` |
| `src/plugin/index.ts` | `ctx.inject(['connection'])` 注册 5 条 `/api/record-replay/*` 路由；插件工具表仍为 26 个 |
| `src/client/plugin/index.tsx` | DSH 客户端入口：`apply` 注册 `main` 与 `sidebar.panellist`，渲染现有 `PanelApp`，API 前缀 `/api/record-replay` |
| `src/client/plugin/styles.css` | 嵌入版样式：跳过 Tailwind preflight，颜色变量收进 `--rr-*`，`dark:` 跟随 `body[data-ds-dark-theme]` |
| `vite.client.config.mjs` | 把 Vite CJS 输出包进 `__ModuleLoader__` 工厂，Tailwind CSS 内联进 factory；React 外置给 shell |
| `tests/unit/panel/fetch-api.test.ts` | 路由契约、Range/HEAD、404/400/403 回归 |
| `tests/unit/plugin/apply-registry.test.ts` | apply 注册 5 条路由且工具数仍为 26 |

关键约束：

- `src/client/panel/api.ts` 的前缀改为参数（默认 `/panel`），全局挂载传 `/api/record-replay`，
  同一套组件同时服务独立命令与 DSH 全局页；
- 独立 `panel` 命令与 `/panel/` 静态页**保留**，用于无 DSH 的 headless 环境与既有 e2e；
- 全局挂载不启动任何监听端口，数据只走 DSH 已认证的同源连接。

### 10.3 验证记录（2026-11-01）

运行一个临时 DSH Web 实例（`DSH_HOME=/tmp/dsh-rr-home`，profile `rr` 只装
`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + 本插件，cwd = 本仓库）：

1. 启动日志：`dsh web: http://127.0.0.1:13091/?token=…`（只有 DSH 一个端口，无 4174/panel 端口）；
2. 左侧栏出现「录制回放」入口（与「插件」「自动化任务」同级）；点击后主区加载面板；
3. 面板列出真实数据：25 条录制 / 65 个 Run / 22% 失败率 / 3.7 MB 视频（35 个文件）；
4. 选中「B站搜索：明日方舟周年庆 v2」后显示 Runs 与 `<video>`；`video.currentSrc` 为
   `/api/record-replay/video?root=…&runId=run_620639e1…`，`readyState=4`、时长 3.3s；
5. 仅 DSH 宿主端口（13091）在监听，仓库内没有新增监听端口。

截图：本地证据，未随公开仓库发布。
### 10.4 最终形态与重启要求

- 最终形态：**DSH 全局面板**（`main` + `sidebar.panellist`），数据走 Host 同源路由；独立
  `panel` 命令降级为调试/headless 入口。
- 已运行的 DSH：Host 半会被插件热重载，但浏览器客户端只在页面启动时读取
  `window.__DSH_BOOT__`；新增 `dsh.client` 后需要**刷新 DSH 窗口**（桌面版无 View→Reload
  菜单时则重启 DSH）才能看到入口。本次验证使用新启动的实例，故无需额外操作。
- 生产使用：`dsh.client` 已写入 `package.json`，`pnpm build` 会产出 `dist/client/client.js`；
  插件以 profile link 方式加载时，重启 DSH 即生效。

## 11. M1.6：右侧栏挂载 + 用例意图（2026-11-01）

### 11.1 右侧栏槽位调研

DSH 0.2.1 的右栏是**会话级**的 docking 面板（`@deepseek-ai/dsh-client-ui-sidebar-right`），
不是全局页签：

| 槽位 / 服务 | 作用 | 证据 |
|---|---|---|
| `rightbar`（single, root） | 右栏整列，由 `ui-sidebar-right` 占用；只在会话主区（Conversation）选中时渲染 `rightbar.session` | `dsh-client-ui-layout` 的 `SlotMap.rightbar` 与 `RightbarRoot` |
| `rightbar.session`（single, session） | 右栏面板本体；按会话 store 记录展开/全屏/标签 | `dsh-client-ui-sidebar-right` 的 `contract/slots` |
| `sidebarRightTabs.register({ id, kind, title, guide })` | 注册一种「页类型」，右栏标签条与 guide 页可见 | `SidebarRightTabRegistry`；`dsh-client-ui-sidebar-documentpreview` 是外部包注册的实例 |
| `sidebar.right.pane.tab`（keyed, session） | 该类型标签的正文，键 = 定义的 `id` | `contract/slots`、`ui-sidebar-terminal` 的两段式注册 |
| `ctx.sidebarRight.openTab(kind)` | 从任意位置打开右栏页并展开右栏 | `ISidebarRight.openTab`；无挂载 seat 时抛错 |
| `sidebar.footer.action`（list, root） | 左栏底部的可加性动作位，条目拥有自己的按钮 | `dsh-client-ui-sidebar` 的 `SlotMap`、`ui-cordis` 的 `CordisPanel` |

**为什么不用 `sidebar.panellist`**：该列表的每一行由侧栏外壳硬编码为
`selectPanel(id)`——它只能选中一个 `main` 主面板。右栏是会话级的面板，没有对应的
`main` id；把行留在 panellist 就等于继续占主区域。`sidebar.footer.action` 是官方
为「左栏新增一个自有按钮」提供的席位，因此 M1.6 把入口移到左栏底部（行为与
「插件」「设置」同列），由按钮自己调用 `sidebarRight.openTab('recordReplay')`。

### 11.2 采用方案

```
DSH 浏览器客户端
├─ sidebar.footer.action: 左侧栏「录制回放 / Record & Replay」按钮
│     └─ click → ctx.sidebarRight.openTab('recordReplay')
│           ├─ 展开右侧栏
│           └─ 选中标签（不调用 ctx.layout.selectPanel，主区不变）
└─ sidebarRightTabs: kind=recordReplay, id=dsh-record-replay
      └─ sidebar.right.pane.tab[key=dsh-record-replay] → PanelApp variant="sidebar"
            └─ 同源 /api/record-replay/*
```

实现文件：

| 文件 | 作用 |
|---|---|
| `src/client/plugin/mount.tsx` | 注册 `sidebarRightTabs` 类型、`sidebar.right.pane.tab` 正文与 `sidebar.footer.action` 入口；`ctx.inject(['sidebarRight','sidebarRightTabs'])` 让右栏服务缺席时插件照常加载 |
| `src/client/plugin/index.tsx` | 仅负责 `import './styles.css'` 与转出 `mount`，使注册逻辑可被 Node 单测直接导入 |
| `src/client/plugin/styles.css` | `.rr-entry*`（左栏按钮，跟随 DSH token，嵌在 `.rr-root` 之外）与 `.rr-root--sidebar` |
| `src/client/plugin/../panel/App.tsx` | `variant: 'page' \| 'sidebar'`；侧栏变体为纵向堆叠：压缩头部（项目选择 + 搜索 + 单行统计）→ 分类/场景树（38% 高）→ 详情 |
| `src/client/panel/components/RecordingDetail.tsx` | `compact`：Runs 行改为两行堆叠、Run 详情卡两列、视频/意图纵向排列 |

窄栏约束：不使用 `md:`（视口断点）判断横向布局，侧栏变体显式走 `flex-col`；
树固定占比后独立滚动，详情区独立滚动，避免在 300–600px 宽的右栏内横向挤压。

### 11.3 用例意图（intent）

数据有两条来源，读取时 index 覆盖 manifest：

| 层 | 字段 | 说明 |
|---|---|---|
| `manifest.json` | `intent?: string` | `cua_record_start` 的可选参数写入；旧录制没有该字段仍合法（`parseManifest` 只在校验到字段时检查非空） |
| `StoreManifest` / `RecordingDescriptor` | `intent?: string` | 存储层与录制服务透传 |
| `RecordingSummary`（Host DTO） | `intent?: string` | 插件适配器映射，`cua_record_query` 的 `recording` / `recordings` 直接返回 |
| `index.json` `assignments[recordingId].intent` | `intent?: string` | 不改录制文件；可只写 intent（`scenarioId` 可省略），场景被删也保留 intent |
| `PanelRecordingSummary` | `intent?: string`, `intentSource?: 'manifest' \| 'index'` | 面板读取：`assignment.intent ?? manifest.intent`；来源用于显示「index 补注 / 录制原文」 |

面板展示：

- Runs 列表上方一行「用例意图」（截断 + 完整文本放 `title`）；
- 视频上方完整块，长文本（>140 字符或含换行）折叠为 3 行，「展开全文 / 收起」；
- 没有 intent：显示录制标题 + 醒目的「未填写用例」，不隐藏整块；
- 搜索同时匹配 intent（`PanelService.search`）。

旧数据兼容：manifest 不写 `intent` 的录制、以及没有 `index.json` 的项目，行为与 M1.5
一致；扫描器仍只读，不创建/改写 `index.json`。

### 11.4 验证记录（2026-11-01）

已运行的桌面版 DSH（`http://127.0.0.1:54200`）中，用带该实例 `dsh-auth` cookie 的
独立 Chromium 打开新页面（不动当前窗口）：

1. 左栏底部出现「Record & Replay」入口（`data-testid=record-replay-entry`）；
2. 点击后右栏展开并出现 `record-replay-tab`；会话输入框仍在主区可见，`location` 不变
   ——确认没有跳主区域；
3. 右栏面板切换项目到本仓库后列出 25 条真实录制；选中「B站搜索：明日方舟周年庆 v2」，
   Runs 列表与 `<video>` 出现，`src=/api/record-replay/video?…&runId=run_620639e1…`，
   `readyState=4`；无 intent 的真实录制显示标题 + 「未填写用例」；
4. 独立 `panel` 入口（`node dist/cli.mjs panel --root …`，`/panel/`）加载新 Host 代码：
   真实录制在视频上方显示 index 补注的完整意图、来源徽标「index 补注」，视频
   `readyState=4`；无 intent 的录制显示标题 + 「未填写用例」。

截图：本地证据，未随公开仓库发布。
> 说明：第 3 步运行中的 DSH 宿主仍是本次构建前的模块图（Node ESM 缓存），因此右栏里
> 的 intent 暂回退为「未填写用例」；第 4 步用同一份真实数据 + 新宿主代码确认了
> intent 展示路径。**Host 侧改动（scanner/DTO）需要重启 DSH**；客户端改动刷新窗口即可。

### 11.5 测试与工具面

- 新增/更新单测：`tests/unit/plugin/client-mount.test.tsx`（右栏类型 + 正文 + 左栏入口，
  点击调用 `openTab('recordReplay')`，无主面板注册，右栏缺席时提示）、
  `tests/unit/panel/scanner.test.ts`（manifest/index intent、旧数据、场景删除保留 intent）、
  `tests/unit/panel/view.test.tsx`（Runs/视频意图、长文本展开、缺失回退、侧栏变体）、
  `tests/unit/recording/recording-service.test.ts`（intent 持久化/空白拒绝）、
  `tests/integration/recording-service-store.spec.ts`（manifest.json 落盘）、
  `tests/unit/host/tools.test.ts`（`cua_record_query` 返回 intent）；
- 工具面不变：apply 仍注册 26 个工具、0 重名；`cua_record_start` 只新增一个可选参数
  `intent`，CLI/套件参数不受影响。

## 12. M3-lite：双击重命名 + 未分组收纳（2026-11-01）

M3 完整操作（重跑/删除/拖拽）仍未做；本次只落地「改名 + 未分组收纳」的写闭环，且**只写
`index.json`**，不改任何 `manifest.json` / `steps.jsonl` / run 文件。

### 12.1 写接口（仅 DSH 同源路由）

与 §10 的 5 条只读接口并列注册在 `connection.fetch`，路径前缀 `/api/record-replay`：

| 方法 | 路径 | 请求体 | 语义 |
|---|---|---|---|
| `PATCH` | `/category?root=…` | `{ id, name }` | 分类改名 |
| `PATCH` | `/scenario?root=…` | `{ id, name }` | 场景改名 |
| `POST` | `/scenario?root=…` | `{ categoryId, name, includeUngrouped? }` | 新建场景；`includeUngrouped` 时把该分类下当前未分组的录制批量写入 assignments |
| `PATCH` | `/recording?root=…` | `{ id, title?, scenarioId? }` | 标题只写 index 覆盖；`scenarioId: null/""` 移回未分组 |

`/recording` 与只读 GET 共用同一路径：路由只注册一次，`methods = [GET, HEAD, PATCH]` 内部分派，
避免宿主按 path 去重时丢掉其中一个方法。独立 `panel` 命令（`/panel/*`）保持只读，不注册写路由。

成功响应（200）返回写后的对象与来源，便于客户端显示/排查：

```json
{ "category": { "id": "bilibili", "name": "视频站", "site": "bilibili" },
  "indexSource": "loaded|rebuilt", "warnings": [] }
```

### 12.2 索引模型扩展

```json
{
  "version": 1,
  "categories": [{ "id": "bilibili", "name": "视频站", "site": "bilibili" }],
  "scenarios": [{ "id": "scn_zhouxianqing", "categoryId": "bilibili", "name": "周年庆" }],
  "assignments": {
    "rec_xxx": { "scenarioId": "scn_zhouxianqing", "intent": "…", "title": "面板里改过的标题" }
  }
}
```

`assignments[recordingId].title` 是新增的可选覆盖字段（与 `intent` 同级）。读取时
`assignment.title ?? manifest.title`，并返回 `titleSource: 'index' | 'manifest'`；manifest 保持字节不变。
assignment 允许只带 `title` / 只带 `intent`（`scenarioId` 可省略）。旧索引不带 `title` 时行为不变。

### 12.3 写入并发与原子性

实现文件 `src/panel/index-writer.ts`：

- **互斥**：`PanelIndexWriteQueue` 按 index 文件路径做进程内 FIFO 串行；`PanelService` 的所有写方法
  共享模块级 `panelIndexWriteQueue`，因此并发改名不会丢更新。读路径不加锁。
- **原子写**：`index.json.tmp-<random>`（同目录，`wx`、0600）→ `writeFile` → `fsync` → `rename`；
  任一步失败清理临时文件并返回 `PANEL_WRITE_FAILED`。并发读只能看到旧版或新版完整 JSON。
- **落盘形状**：`serializePanelIndex` 固定按 id/recordingId 排序、丢弃空字段、末尾换行；写前再
  `parsePanelIndex` 校验一次，拒绝写入无法回读的索引。
- **范围**：只 `mkdir`/写 `index.json`，不触碰 recordings 目录。

### 12.4 校验与错误码

| 错误码 | HTTP | 触发 |
|---|---|---|
| `PANEL_INVALID_BODY` | 400 | 请求体不是 JSON 对象、缺字段、`includeUngrouped` 非布尔 |
| `PANEL_INVALID_NAME` | 400 | 名称去空白后为空 / 超 80 字符 / 含控制字符 |
| `PANEL_INVALID_ID` | 400 | 分类/场景 id 不匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`，或 recording id 不匹配 `^rec_…` |
| `PANEL_CATEGORY_NOT_FOUND` / `PANEL_SCENARIO_NOT_FOUND` / `PANEL_RECORDING_NOT_FOUND` | 404 | id 不存在 |
| `PANEL_SCENARIO_MISMATCH` | 400 | 把录制归入其它分类的场景 |
| `PANEL_INDEX_CORRUPT` | 409 | index.json 不是 JSON / 不是 v1 对象；**不写盘** |
| `PANEL_INDEX_UNREADABLE` / `PANEL_WRITE_FAILED` | 500 | 读/写文件系统失败 |

名称在所有入口统一 `trim()`；空白名和超长名在打开文件前就被拒绝。

### 12.5 索引损坏策略

1. 文件不存在：按 recording site 重建 categories（`mergeIndex`），assignments 为空，来源 `rebuilt`；
2. 文件是合法 v1：保留名称/场景/assignments，补上缺失站点的分类，来源 `loaded`；
3. 文件是 v1 但局部非法（categories/scenarios 结构坏）：按 site 重建分类，保留每一条可读的
   assignment（含 intent/title；场景引用仅在场景本身可恢复时保留），来源 `rebuilt`；
4. 文件不是 JSON 或不是 v1 对象：`PANEL_INDEX_CORRUPT`，**一个字节都不写**。

### 12.6 面板交互

- 双击分类/场景/录制标题 → 行内输入；Enter 保存、Esc 取消、失焦保存；保存中禁用输入，重复提交被
  `pendingRef` 拦截；失败保持编辑态并用 toast 显示错误码。
- 双击「未分组」→ 弹窗「新建场景并收纳当前 N 条录制」；确认后调用 `POST /scenario`
  （`includeUngrouped: true`），成功后该分类的未分组行消失。
- 写成功后 invalidate `['panel','project',root]`、`['panel','recording',root]`、`['panel','search',root]`，
  树、列表、详情标题一起刷新。
- 写能力由 `PanelApi.write` + `PanelApp writable` 决定：DSH 右栏挂载 `writable`；独立 `/panel/`
  保持只读（无双击编辑、无弹窗）。

### 12.7 测试与重启

- `tests/unit/panel/index-writer.test.ts`：原子写（无临时文件残留）、并发串行、校验/未知 id、
  未分组收纳、标题覆盖（manifest 字节不变）、缺失/局部损坏/不可解析索引；
- `tests/unit/panel/fetch-api.test.ts`：路由表、PATCH/POST 成功路径、400/404/405/409；
- `tests/unit/panel/writes-integration.test.tsx`：真实 `PanelService` + fetch 路由 + React，
  双击改场景/录制名后树与详情刷新、未分组收纳后虚拟组消失、manifest 不变；
- `tests/unit/panel/view.test.tsx`：双击进入编辑、Enter 保存、Esc 取消、失败 toast、只读入口；
- `tests/unit/plugin/apply-registry.test.ts`：仍 26 个工具、0 重名、7 条路由。

**重启要求**：Host 侧新增写路由与 writer（`src/panel/*`），已运行的 DSH 需要重启宿主；客户端
`writable` 改动刷新窗口即可（若宿主模块缓存未更新，写请求会 404/405）。

## 13. 项目选择与默认项目（2026-11-01）

### 13.1 问题

右侧栏面板第一次打开时默认落到 `desktop`（`~/.dsh/profiles/desktop`），
统计为 0 录制 / 0 Run / 0 视频，看起来像「编辑未实现」。根因：
`PanelService` 把 `process.cwd()` 当作「当前项目」并排在列表第一位，而 DSH
宿主进程的 cwd 是 profile 目录（或应用启动目录），不是用户工作区。

### 13.2 项目来源

| 来源 | 是否进入选择器 | 说明 |
|---|---|---|
| DSH 工作区（`~/.dsh/storages/workspace.json`） | 是 | 主来源；`updatedAt` 作为最近使用信号 |
| 用户通过「打开文件夹」选中的目录 | 是 | 持久化到 `~/.dsh/record-replay-panel.json`，最多 20 条 |
| `--root` 显式目录 | 是 | 独立 `panel` 命令与测试使用 |
| 独立命令的 cwd | 是 | 用户显式在该目录启动面板 |
| DSH 宿主的 cwd | 否 | 宿主传 `cwd: null`；profile/应用目录不算项目 |
| `~/.dsh/**`、`/`、用户 home | 客户端兜底 | 宿主 cwd 由 `cwd: null` 排除；`last-root` 命中这些路径时客户端忽略 |

`GET /projects` 为每个项目附带一次 `readdir` 得到的 `recordingCount`
（不解析 manifest）。只有 `resolveRoot` 的请求路径不计算该字段。

### 13.3 默认项目规则

1. 上次显式选中的项目（`localStorage['dsh-record-replay:last-root']`），
   但必须通过下列校验，否则**本次启动忽略并继续走 2–6**；
2. 当前 DSH 会话所在工作区，且该工作区有录制；
3. 独立命令的当前目录（`isCurrent`）；
4. 第一个有录制目录的项目；
5. 列表第一个项目；
6. 都没有才显示「没有可用的项目」。

`last-root` 校验（`src/client/panel/lib/project-defaults.ts`）：

- 根目录不存在（不在 `GET /projects` 结果中）→ 忽略；
- 位于 DSH home（`~/.dsh/**`）、用户 home（`/Users/<name>`、`/home/<name>`、
  `/root`、`/var/root`）或文件系统根 `/` → 忽略；
- 存在但没有 `.dsh/record-replay/recordings`，或 `recordingCount === 0`
  → 本次启动忽略；
- 未上报 `recordingCount` 的旧宿主视为「未校验」，同样不提升到优先级 1；
- 校验失败**不删除**用户的存储值：它可能在后续启动中重新变得有效，或由用户
  再次显式选中。

自动采用的默认值不写回 localStorage，只有用户在选择器中选中、或用
「打开文件夹」添加后才持久化，避免默认值被误当成「上次选中」。

### 13.4 任意文件夹与空态

- 项目选择器右侧的 folder-plus 按钮调用 DSH 的目录选择器
  （`ctx.uiWorkspace.pickDirectory()`），成功后 `POST /root` 注册并记住目录；
  独立 `/panel/` 没有该按钮。
- 空态区分：
  - `project-missing` / `tree-project-missing`：根目录被移动或删除
    （`PANEL_ROOT_NOT_FOUND`），提示重新选择或打开文件夹；
  - `project-empty` / `tree-empty`：项目存在但没有
    `.dsh/record-replay/recordings`，文案带项目名与根路径。
- `project-empty` 空态在存在其它 `recordingCount > 0` 的项目时提供
  「切换到有录制的项目」：点击展开这些项目，选中即持久化并切换；
  「打开文件夹」仍并列保留。当前项目自身不出现在候选里（切换是空操作）。

### 13.5 验证

- `pnpm exec tsc --noEmit`、`pnpm build` 通过；
- 单元/集成测试 **443 passed | 3 skipped**，其中
  `tests/unit/panel/project-defaults.test.ts` 覆盖默认规则、`last-root`
  的路径/存在性/录制数校验，`service.test.ts` 覆盖 profile 过滤 /
  `cwd: null` / `registerRoot` 持久化，`view.test.tsx` 覆盖默认选中、
  脏 `last-root`（desktop）、空态切换按钮与文件夹选择流程；
- 浏览器 e2e（真实 `dist/panel` 构建 + 独立 `panel` 服务，`DSH_HOME`
  指向临时目录，避免污染本机状态）：先用 `POST /panel/root` 注册
  `~/.dsh/profiles/desktop`（0 录制）并写入脏
  `localStorage['dsh-record-replay:last-root']`，页面仍默认
  `dsh-record-and-replay 25 录制`，存储值保持不变；在选择器中切到
  `desktop` 后出现「这个项目还没有录制」与「切换到有录制的项目」，
  展开列表仅有 `dsh-record-and-replay 25 录制`，点击即切换并持久化；
- AX 右栏 e2e（2026-11-01 前一轮，另起 DSH 实例）：
  全新 origin 打开右侧栏面板即默认 `dsh-record-and-replay 25 录制`；
  双击 `B站` 出现 `AXTextField "分类名称 B站"`；双击 `未分组 9` 出现
  `新建场景并收纳当前 9 条录制` 对话框，输入「明日方舟周年庆」后
  `index.json` 新增 `scn_89bb1ad974` 与 9 条 assignment；双击该场景出现
  `AXTextField "场景名称 明日方舟周年庆"`。两条 manifest 的 sha256 前后一致。
- 截图：本地证据，未随公开仓库发布（避免泄露本机工作区与账号信息）。
- AX 记录：
  [`../spikes/2026-11-01-panel-ax-e2e/README.md`](../spikes/2026-11-01-panel-ax-e2e/README.md)

宿主侧（scanner/service/route）改动需要重启 DSH 才会加载；只刷新窗口
只能拿到客户端 bundle。独立 `panel` 命令需要重新 `pnpm build` 后重启。
本次 `last-root` 校验与空态切换只改 `src/client/panel/**`，刷新/重开面板
即可生效，不需要重启 DSH 宿主。

## 14. M2：跨项目搜索、统计与分页（2026-11-01）

### 14.1 范围

设计 §7 的 M2 落地为三块能力，全部只读、不改 `.dsh/`：

1. **跨项目搜索**：`GET /search` 不传 `root`（或 `root=*`）时并行扫描白名单内所有项目，
   结果按项目分组，可点击结果切换项目并选中录制；
2. **统计**：系统级（项目数/总录制/总 Run/失败率/视频占用）与逐项目卡片，
   数据只来自现有 `scanProject` 的输出，不额外遍历文件；
3. **分页**：项目列表与 Recording 列表支持 `limit`/`offset`，默认 50；搜索与统计不受分页影响。

新增/修改文件：

| 文件 | 作用 |
|---|---|
| `src/panel/concurrency.ts` | `mapWithConcurrency`：固定 4 个 worker，保持输入顺序，供跨项目扫描复用 |
| `src/panel/pagination.ts` | `parsePagination`（50/200）、`parseSearchLimit`（100/500）、`paginate` |
| `src/panel/types.ts` | `PANEL_ALL_PROJECTS_ROOT='*'`、`PanelPageMeta`、`PanelProjectsPage`、`PanelSystemStats`、`PanelStatsReport`、跨项目搜索 DTO、`PANEL_INVALID_PAGINATION`/`PANEL_INVALID_LIMIT` |
| `src/panel/service.ts` | `searchAll`、`getStatsReport`、`listProjectsPage`；`getProject(root, page)` 只分页 recordings，categories/scenarios/stats 仍描述整个项目 |
| `src/panel/http.ts` / `fetch-api.ts` | `/stats`、`/search` 全项目分支、`/projects` 与 `/project` 的 `limit`/`offset` |
| `src/client/panel/components/AllProjectsPanel.tsx` | “全部项目”左栏（项目统计列表 / 分组搜索结果）、主区占位与虚拟滚动 |
| `src/client/panel/App.tsx` | 模式切换、infinite queries、跨项目结果点击切换、系统统计卡片 |
| `src/client/panel/components/StatsCards.tsx` | `system` 变体：项目/总录制/总 Run/失败率/视频占用 |
| `src/client/panel/components/Tree.tsx` | 录制分页“加载更多”与 `已加载 X / Y` 计数 |

### 14.2 接口

```
GET /projects?limit=50&offset=0
  → { projects: [...], page: { total, limit, offset, hasMore } }

GET /project?root=…&limit=50&offset=0
  → { project: { categories, scenarios, recordings[一页],
                 recordingsTotal, recordingsPage: { total, limit, offset, hasMore },
                 stats } }

GET /search?q=…                      # 或 root=*
  → { query, groups: [{ projectRoot, projectName, matches: [
        { recording, matchKind: 'recording'|'run', matchedRuns, categoryName?, scenarioName? }
      ] }], total, returned, limit, truncated }

GET /search?q=…&root=…               # 单项目，保持 M1 形状
  → { query, recordings, runs, matches }

GET /stats
  → { system: { projects, recordings, runs, failedRuns, cancelledRuns,
                failureRate, videoFiles, videoBytes, steps },
      projects: [{ root, name, stats }] }
```

约束：

- `limit`/`offset` 必须是范围内的安全整数；非法值返回 400
  `PANEL_INVALID_PAGINATION`（搜索为 `PANEL_INVALID_LIMIT`），不做静默截断；
- `offset` 超出总数返回空数组和完整 `total`/`hasMore=false`，不报错；
- 搜索 `limit` 默认 100、最大 500；分页默认 50、最大 200；
- 搜索仍匹配标题、recordingId、intent，并新增分类名/场景名、Run `errorMessage`；
- 跨项目结果先按项目分组，再按选择器顺序应用全局上限；只返回有命中的项目。

### 14.3 并发与一致性

`mapWithConcurrency(items, 4, mapper)` 用 `min(4, items.length)` 个 worker 共享一个游标，
每个 worker 顺序取下一个项目；结果写入原索引位置，因此项目顺序稳定。
`searchAll` 与 `getStatsReport` 都走这条路径，避免一次打开全部项目的文件描述符。
两次调用之间没有缓存：统计与搜索都反映调用时的磁盘状态。

### 14.4 客户端行为

- 项目选择器新增“全部项目”（值 `*`）；该模式不写 `localStorage` 的 `last-root`，
  避免下次启动把哨兵当成真实路径；
- 全部项目模式：头部显示系统级 5 张统计卡片，左栏按项目列出
  `录制 / Run / 失败率 / 视频占用`；搜索结果切换为按项目分组的结果列表，
  每行显示标题、recordingId、分类/场景、匹配 Run 的状态与时间；
- 点击跨项目结果 → `openRecording(root, recordingId)` 一次更新项目与选中项，
  清空搜索并加载该项目的 classification 树与详情；
- 分页：`useInfiniteQuery` + `limit=50`；树底部“加载更多录制”、项目列表
  “加载更多项目”按 `hasMore` 出现；超过 80 行继续使用 TanStack Virtual；
- 单项目模式仍使用原有 `/search?root=`，树内过滤行为不变。

### 14.5 测试与验证（2026-11-01）

- `tests/unit/panel/cross-project.test.ts`：
  - `mapWithConcurrency` 峰值并发 = 4、顺序保持、空输入/非法 limit；
  - 跨项目分组、分类/场景上下文、Run 匹配、`root=*`/缺省/单项目、无命中；
  - 全局 `limit` 截断与 `truncated`、非法 limit、空查询；
  - 系统统计聚合（4 录制 / 3 Run / 2 失败 / 12 B 视频、失败率 2/3）；
  - `parsePagination` 边界、项目列表分页、录制分页与越界 offset；
- `tests/unit/panel/fetch-api.test.ts`：新增 `/stats` 路由、无 root 跨项目搜索、
  `root=*`、分页元数据、`PANEL_INVALID_PAGINATION`/`PANEL_INVALID_LIMIT`；
- `tests/unit/panel/http.test.ts`：独立服务器的跨项目搜索、`/stats`、分页；
- `tests/unit/panel/view.test.tsx`：全部项目搜索 → 点击结果切换项目并选中、
  系统统计卡片、录制分页加载、项目列表分页加载；
- `tests/unit/plugin/apply-registry.test.ts`：路由表新增 `/stats`，工具表仍 26 个、0 重名。

结果：`pnpm exec tsc --noEmit`、`pnpm build` 通过；全量测试
**460 passed | 3 skipped**（M1 基线 443，M2 新增 17）。用本仓库真实数据校验：

```text
system: projects=1 recordings=25 runs=65 failedRuns=14 failureRate=21.5%
        videoFiles=35 videoBytes=3.9 MB
GET /project?limit=5 → recordingsTotal=25, hasMore=true
GET /search?q=搜索&limit=3 → total=4 returned=3 truncated=true
```

浏览器验证（`node dist/cli.mjs panel` 独立服务 + 本仓库真实数据）：项目选择器切到
「全部项目」后显示 1 个项目、25 录制、65 Run、22% 失败率、3.7 MB / 35 个视频；
搜索「搜索」返回 4 条并按项目分组；点击第一条后选择器切回
`dsh-record-and-replay`，详情展示该录制的用例意图与 Runs，无 console error。
结果行自动测高，检查 4 行的 `top/bottom` 无重叠。


### 14.6 重启要求

- Host 侧（`src/panel/**` 的 service/route/types、`concurrency.ts`、`pagination.ts`）
  需要**重启 DSH** 才会加载；
- 客户端 `src/client/panel/**` 与新增组件，刷新/重开面板即可；
- 独立 `panel` 命令需重新 `pnpm build` 后重启。

## 15. M3：重跑、移到回收站、键盘导航（2026-11-01）

### 15.1 目标与边界

M3 把两条此前只能走 CLI 的操作搬进面板：**重跑一条录制**和**把录制移到回收站**，
并补上面板内的键盘导航。三条硬约束：

- 重跑必须复用 Host 的 ReplayPort（与 `cua_replay_start`、CLI 同一条执行链），
  新 Run 落在原录制的 `runs/<runId>/`，而不是面板自建目录；
- 删除**绝不 `rm -rf`**：只做一次 `rename` 到 `trash/`，数据保持完整；
- 独立 `panel` 进程没有浏览器驱动，重跑必须显式返回
  `PANEL_REPLAY_UNAVAILABLE`，客户端禁用按钮并说明原因。

深链接（`#root=…&recording=…`）本轮**跳过**：面板挂在 DSH 右侧栏，右栏是会话内
的 pane 而不是独立页面，没有可写的地址栏，hash 既不会产生也不会在重开时保留。
项目/录制选择已经由 localStorage（`dsh-record-replay:last-root`）在单项目模式下延续，
因此不引入一个在目标环境不可用的恢复机制。

### 15.2 接口

```
GET  /capabilities                      → { replay: boolean, trash: boolean }
POST /replay { root, recordingId, values? }
  → { runId }                           # Run 已落盘，立即返回；客户端轮询 /recording
  → 503 PANEL_REPLAY_UNAVAILABLE        # 本进程没有 replay 服务
  → 409 PANEL_REPLAY_FAILED             # 上游错误，消息保留上游 code（如 RECORDING_INCOMPLETE）
  → 400 PANEL_INVALID_ID / PANEL_INVALID_BODY / 404 PANEL_RECORDING_NOT_FOUND
POST /trash { root, recordingId }
  → { recordingId, trashPath, movedAt, indexCleaned }
```

`root` 以 body 为准（query 仍兼容）。两个接口都只在 DSH fetch 挂载上注册；
独立 `panel` 命令保留 `/capabilities`（`trash:false`）与 `/replay`（503），不注册
`/trash`，维持“独立命令只读”的既有约定。

### 15.3 重跑桥（src/plugin/panel-replay.ts）

面板没有 agent 会话，只有项目根，因此 bridge 做三件事：

1. `runtimeForRoot(root)` 取该工作区的 runtime（插件按根缓存），调用
   `runtime.replay.startReplay`；principal 固定为 `{ sessionId: 'panel',
   agentId: 'panel' }`（Run 记录不落 ownerSessionId，读取走扫描器，不需要会话所有权）；
2. `target` 固定 `{ launch: 'isolated' }`：面板永远不接管会话已绑定的浏览器窗口；
3. `ReplayPort.startReplay` 是“跑完才 resolve”的语义，bridge 改为在
   `onRunStarted(runId)` 回调时 resolve，HTTP 立即返回 runId，回放继续在后台跑。
   Run 已创建后的失败（绑定失败、步骤失败）已经写进 `run.json`，由轮询呈现；
   Run 创建前的失败（RECORDING_INCOMPLETE / REPLAY_UNSUPPORTED_STEP 等）才 reject，
   由 service 映射成 `PANEL_REPLAY_FAILED`。

客户端在详情页用 `refetchInterval` 轮询 `GET /recording`（仅当本面板启动的 Run
处于 `preparing`/`running`，1.2 s/次，5 分钟上限）。Run 出现后自动选中；到达终态后
停止轮询、刷新项目树与统计，并显示成功/失败 toast。Host 在 `run.json` 写成
`completed` **之后**才 finalize WebM，因此终态时会立即刷新一次、1.5 s 后再补一次，
避免读到 0 字节视频。

### 15.4 回收站策略

- 目标目录：`<project>/.dsh/record-replay/trash/<recordingId>-<compact UTC stamp>/`，
  例如 `trash/rec_abc-20261101T102350123Z`；时间戳去掉 `:/.`，便于 shell 与排序；
- 一次 `rename` 移动整个目录：manifest、steps.jsonl、runs/、assets/ 字节不变；
- 同名冲突依次追加 `-2`、`-3`…，绝不覆盖已有回收站条目；
- 安全校验：id 必须匹配 `^rec_[A-Za-z0-9_]+$`；`lstat` 必须是真实目录（符号链接
  直接 403 `PANEL_ROOT_DENIED`）；realpath 必须落在 `recordings/` 内；`trash/`
  的 realpath 也必须落在 store 内；
- 移动成功后经串行队列从 `index.json` 删除该录制的 assignment（无 assignment 时
  返回 `indexCleaned:false`）；若 index 写入失败，把目录 `rename` 回原位再报错，
  不留下“已移走但索引还在”的半完成状态；
- 面板暂不展示回收站内容：树只读 `recordings/`，刷新后该录制自然消失。恢复方式
  是手动把目录移回 `recordings/`（文档写明）。

### 15.5 客户端行为

- 详情头部新增「重跑」「移到回收站」两个按钮；两者都弹自绘确认框（不是
  `window.confirm`，避免阻塞整个 DSH 窗口）。重跑确认文案明确“隔离窗口 + 写动作
  会真实执行”；回收站确认文案明确“移动而非删除 + 可从磁盘恢复”；
- 重跑按钮在 `recording.status !== 'completed'`、无 replay 服务、或在途时禁用，
  并用 title + 提示行解释原因；运行中显示 `Run <id>` + 状态徽章；
- 键盘模型（树、跨项目结果列表、Runs 列表）：
  `↑`/`↓`/`Home`/`End` 移动焦点（`data-keyboard-row` 行、`scrollIntoView`），
  `Enter`/`Space` 走原生按钮激活，`F2` 对分类/场景/录制进入重命名（未分组打开
  新建场景弹框），`Esc` 在编辑器中取消、否则离开行焦点。输入框/文本域/可编辑区域
  内的按键一律忽略，输入不会被导航抢走；行使用 `focus-visible` 焦点环，树头部
  显示「↑↓ 移动 · Enter 打开 · F2 重命名」提示。

### 15.6 测试与验证

新增/更新：

- `tests/unit/panel/actions.test.ts`（13）：capabilities、重跑参数透传、无服务 503、
  非法 id/未知录制/非法 values/越权 root、上游错误映射、空 runId；回收站移动 +
  index 清理 + manifest/steps/video 字节一致、无 assignment、冲突后缀、未知/非法/
  越权、符号链接拒绝、trash 目录越界拒绝；
- `tests/unit/panel/actions-routes.test.ts`（6）：DSH fetch 面的 capabilities/replay/
  trash 路由与 503 分支、非 JSON body；独立 HTTP 面的 capabilities、503 与“无
  trash 路由、不移动数据”；
- `tests/unit/panel/actions-view.test.tsx`（6）：无服务时按钮禁用与提示、确认框 →
  重跑 → 轮询 running → completed → 视频可播放 → 树 Run 数刷新、运行期 503 禁用、
  回收站确认 → 树中消失 + 成功 toast + index 清理 + trash 完整副本、键盘
  ↑↓/Enter/F2/Esc 与跨项目结果列表；
- `tests/unit/plugin/panel-replay.test.ts`（5）：重跑桥在 `onRunStarted` 即返回
  runId（后台未完成）、values/target/principal、无 Run 报错、Run 前失败上抛、
  Run 后失败吞掉；
- `tests/unit/panel/fetch-api.test.ts`、`tests/unit/plugin/apply-registry.test.ts`：
  路由表新增 `/capabilities`、`/replay`、`/trash`，工具仍 **26 个、0 重名**。

结果：`pnpm exec tsc --noEmit`、`pnpm build` 通过；全量测试
**490 passed | 3 skipped**（M2 基线 460，M3 新增 30）。

真实链路验证（本仓库真实录制，真实 cua-driver 0.38.0 + ffmpeg，非 mock）：

```text
capabilities { replay: true, trash: true }
started run run_365c39ba0dba43ceb097a709d594b2ca
poll running  video=true  runs/run_365c39ba0dba43ceb097a709d594b2ca/video/replay.webm
poll completed video=true runs/run_365c39ba0dba43ceb097a709d594b2ca/video/replay.webm
run.json: status=completed, durationMs=4949
video/replay.webm: 148959 bytes
```

即：面板 service 的重跑调用真正启动了隔离 Chromium、写完步骤、在原录制目录下
生成了新 Run 与可播放 WebM。回收站路径与 index 清理由 `actions.test.ts` 用真实
临时工作区验证（原目录不存在、trash 下完整副本、manifest 字节不变）。

独立 `panel` 页面（真实数据、Playwright 冒烟）：树 25 条录制、详情显示新 Run
`run_365c…` 与 145.5 KB 可播放视频；重跑按钮因无回放服务而禁用并显示说明，
trash 按钮不出现（独立模式只读）；键盘 `↓` 从分类行移到场景行，无 console error。


### 15.7 重启要求

- Host：`src/panel/**`（service/types/paths/index-writer/http/fetch-api）与插件
  `src/plugin/panel-replay.ts`、`src/plugin/index.ts` 需要**重启 DSH**；
- 客户端：刷新/重开右侧栏面板即可（`dist/panel` 与 `dist/client/client.js` 已重建）；
- 独立 `panel` 命令：重新 `pnpm build` 后重启。

## 16. 树形层级重做：分类 / 场景 / 录制（2026-11-01）

右侧栏只有约 380–420px 宽，旧树把分类、场景、录制都渲染成近似权重的平铺行，
用户反馈“看不出层级”。本次只改客户端 `src/client/panel/**`，Host 接口与工具表不动。
第一版层级重做后仍有一个对齐缺陷：录制行没有 chevron 占位和叶图标，标题从行首
（40px）开始，比场景标题（约 68px）还靠左；本次把三级行统一成固定列后修掉。

### 16.1 缩进、固定列与导轨

每级行都使用同一套固定列：

```
[indent] [chevron 16px] [gap 8px] [icon 16px] [gap 8px] [text]
```

| 层级 | `padding-left` | 文字列 x | 行的可访问标记 | 导轨 |
|---|---|---|---|---|
| 分类 | 8px（深度 0） | 56px | `role=treeitem`、`aria-level=1`、`data-depth=0` | 无（根级） |
| 场景 | 24px（+16px） | 72px | `aria-level=2`、`data-depth=1` | 父级 1 条竖导轨（x=40）+ 行内 8px 短横线 |
| 录制 | 40px（+32px） | 88px | `aria-level=3`、`data-depth=2` | 父级 2 条竖导轨（x=40 / 56）+ 行内 8px 短横线 |

- 缩进用行内 `style.padding-left`（`TREE_LAYOUT` 常量）实现，不再用 `pl-*` class；
  三级文字列由固定列推导，严格递增（56 < 72 < 88）；
- 录制行保留空的 chevron 列（`data-tree-chevron-placeholder`）并显示叶节点文件图标
  （`data-tree-leaf`），所以标题从 88px 列开始，**严格在场景标题右侧**，不再从行首
  或比场景更靠左的位置起排；
- 竖导轨画在每一行内（`[data-tree-rail]`，x=40px / 56px，对齐父级 icon 中心），
  不是一条贯穿全树的全局线；折叠后子行不渲染，导轨自然随子树一起消失；
- 行间 `py-0.5` 的 4px 空隙由导轨的 `top/bottom: -2px` 补齐，同一分支内视觉连续；
  行内 8px 短横线（`[data-tree-rail-stub]`）从导轨指向本行 icon（场景 40→48，
  录制 56→64）；
- 未分组场景的虚线边框改用 `outline`（`outline-offset: -1px`）而不是 `border`，
  不占布局像素，避免 1px 位移把场景 icon 挤离父级导轨；
- 滚动容器 `overflow-x-hidden`，行 `min-w-0` + 文本 `truncate`，400px 宽实测
  `scrollWidth === clientWidth`（无横向滚动）。

### 16.2 排版与计数

- 分类：`text-[14px] font-semibold` + Folder/FolderOpen 图标；
- 场景：`text-[13px] font-medium` + 16px Layers3 图标；
- 录制：标题 `text-[13px] font-normal` + 16px FileText 叶图标，第二行
  `步数 · Run 数 · 更新时间`，右侧 `StatusBadge` 状态 pill（完成 / 失败 / 录制中 / 中断）；
- 分类与场景计数使用 `w-8` 固定宽度右对齐 + `tabular-nums`，状态 pill 容器 `w-14`；
- 分类/场景/录制标题都是 `truncate`，完整文本放进 `title`；右侧计数与状态列
  `shrink-0`，长标题只截断自己，不挤压右侧；
- 空分类在正常浏览时保留（计数 0）；搜索态只保留含命中录制的分支，空分类不出现；
- 已声明但尚无录制的场景同样保留，分类结构不会因删/移录制而突然变形。

### 16.3 虚拟节点「未分组」与选中态

- 未分组行使用 `outline-dashed`（内缩 1px）+ `bg-muted/25` + 灰色斜体文字，`data-virtual-group=true`；
  双击 / F2 仍走“新建场景并收纳”对话框；
- 选中录制：左侧 2px `bg-primary` 高亮条 + `bg-accent` 背景，保留 `aria-current`、
  `aria-selected` 与 `focus-visible` 焦点环。

### 16.4 交互

- 行内操作（改名 / 重跑 / 回收站）默认 `opacity-0`，hover 或 focus-within 时显示；
  不可见时 `aria-hidden` + `tabIndex=-1`，不会成为隐藏 tab 停靠点；重跑/回收站复用
  自绘确认框（`tree-replay-confirm` / `tree-trash-confirm`），不阻塞 DSH 窗口；
- 计数的右侧元信息在 hover 时淡出，给操作条让位，避免状态 pill 与图标重叠；
- 整行仍是原生 `<button>`：Enter 展开/选中；`↑`/`↓` 只在已渲染（未折叠）行间移动；
  F2 进入改名；chevron 有 `transition-transform` 旋转；Esc 行为不变。

### 16.5 加载与测试

- `Tree` 内联骨架与 `TreeSkeleton` 都按 0 / +16px / +32px 缩进（`data-skeleton-depth`）；
- `tests/unit/panel/tree-hierarchy.test.tsx`（13）：三级固定列（`padding-left` 8/24/40px、
  文字列 56/72/88px 严格递增）、录制行空 chevron 占位 + 叶图标、`truncate`/`title`、
  导轨数量/坐标/短横线与折叠后的消失、chevron 旋转与整行点击、空分类/空场景、
  未分组虚线样式与双击收纳、hover 操作可见性、行内重跑确认、选中高亮条、搜索过滤、
  折叠后的方向键导航、两种骨架缩进；
- 全量：`pnpm exec tsc --noEmit`、`pnpm build` 通过；**503 passed | 3 skipped**；
  工具表仍为 **26**（纯客户端改动）。

### 16.6 截图（真实数据 25 条录制，400px 宽侧栏）




> 截图取自独立只读 `panel` 入口（同一份真实 `.dsh/record-replay` 数据），把树所在
> `aside` 固定为 400px 以匹配 DSH 右侧栏宽度；只读入口没有 hover 操作条，
> 写入口的操作条由组件测试覆盖。

### 16.7 重启要求

仅客户端改动：重新 `pnpm build` 后，刷新/重开 DSH 右侧栏面板即可（`dist/panel` 与
`dist/client/client.js` 已重建）；不需要重启 DSH 宿主，也不需要重启独立 `panel` 命令
——它直接从 `dist/panel` 读静态文件，刷新页面就能拿到新 bundle。

## 17. Recording 详情布局与 Run/视频对应关系（2026-11-01）

用户反馈两点：打开详情后「分类 / 场景」树被整块替换，失去当前位置；详情里标题、
Runs 表和一块空的「回放视频」各自为政，「用例意图」又把标题重复一遍并挂
「未填写用例」。本次只改客户端 `src/client/panel/**`，Host 接口、工具表和数据格式不变。

### 17.1 保留树上下文

- 树不再因为选中 Recording 而卸载：详情走主区（`main`），树继续留在 `aside`；
  选择/返回只更新 `selectedRecordingId`，`expanded` 与树滚动容器的 `scrollTop`
  原样保留（组件测试直接断言折叠状态和 `scrollTop`）。
- 详情头部固定在顶部（`sticky top-0`），最上面一行是
  `← 返回` + 面包屑 `分类 › 场景`；分类/场景名称由 `PanelProject` 解析后传入
  `RecordingDetail`，不新增 Host 字段。未分组的录制显示 `分类 › 未分组`。
- `← 返回` 清空选择回到树的空态；树没有重新挂载，因此原展开/滚动位置不丢。
  窄栏里树仍在上方，详情在其下方滚动，面包屑让用户始终知道当前录制属于哪一支。

### 17.2 详情结构

```
sticky header
  ← 返回   分类 › 场景                       [重跑] [移到回收站]
  Recording 标题  [状态 pill]
  ID（可复制）· 站点 · 步数 · Run 数 · 创建 · 更新时间
  （可选）重跑不可用说明 / 重跑进度条
概览
  用例意图（或「未填写用例」提示）
  Run 汇总（Runs / 失败 / 有视频）
Runs
  Run 行（点击选中，左侧 2px 主色条 + accent 背景 + 焦点环）
视频
  「回放视频」+ 状态 + runId
  当前选中 Run 的 <video controls> / 明确的无视频空态
  Run 详情（状态、耗时、开始/结束、视频大小）
  失败/取消错误块（有错误时）
```

- 页面变体内容居中限制在 `max-w-5xl`；侧栏变体仍显式 `flex-col`，不依赖 `md:`
  视口断点，避免 300–600px 右栏里的横向挤压。
- Runs 列表从 `role=list` 改为 `role=listbox` + `role=option`，保留
  `data-keyboard-row`，`↑/↓/Home/End` 与 Enter 行为不变；选中行同时暴露
  `aria-selected`、`aria-current` 和 `data-selected`。
- 视频区只渲染当前选中 Run：选中的 Run 没有视频时显示 `video-empty` 空态
  （标题 + 原因），不再出现与选中 Run 无关的空「回放视频」块。
- 视频加载时显示 `video-skeleton` 骨架，`loadedmetadata` / `canplay` 后移除；
  加载失败时在播放器内显示可下载提示。下载链接仍指向 `download=1`。

### 17.3 用例意图

- 有 intent：显示原文、来源徽标（`录制原文` / `index 补注`）；超过 140 字符或含
  换行时折叠为 3 行，提供「展开全文 / 收起」。
- 没有 intent：只显示虚线框「未填写用例」+ 补注提示，**不再回退成 Recording 标题**。
  `resolveIntent()` 在缺失时返回空文本，标题只在详情头部出现一次。
- 原 Runs 列表上方的 inline 意图块与视频上方的 full 意图块合并为概览里唯一一块，
  避免同一段文字在页面中出现两次。

### 17.4 验证记录（2026-11-01）

- `tests/unit/panel/view.test.tsx`（27）：详情面包屑、Meta（ID/站点/步数/复制按钮）、
  Runs 选中切换视频、选中条与 `aria-selected`、视频骨架移除、无视频空态、
  无 intent 不重复标题、长意图展开、侧栏变体，以及
  「返回后树仍挂载、折叠状态和 scrollTop 不变」。
- 全量：`pnpm exec tsc --noEmit`、`pnpm exec vitest run`、
  `pnpm build` 通过；**504 passed | 3 skipped**；工具表仍为 **26**
  （纯客户端改动）。
- 真实 25 条录制的独立 `panel` 入口，400px 宽视口：`documentElement`、
  `main`、`recording-detail` 的 `scrollWidth === clientWidth`，无横向滚动。

### 17.5 截图（真实数据 25 条录制，400px 宽）




> 截图取自独立只读 `panel` 入口（同一份真实 `.dsh/record-replay` 数据），不修改
> 任何录制；独立入口没有回放服务，因此头部会显示禁用重跑的说明，DSH 宿主内不会出现。

### 17.6 重启要求

仅客户端改动：重新 `pnpm build` 后，刷新/重开 DSH 右侧栏面板即可
（`dist/panel` 与 `dist/client/client.js` 已重建）。不需要重启 DSH 宿主；桌面版
若窗口仍加载旧 bundle，重启 DSH 桌面应用一次即可（不需要重启独立 `panel` 命令，
它从 `dist/panel` 读静态文件，刷新页面就能拿到新 bundle）。

## 18. 上下分栏：列表常驻、详情在下方（2026-11-01）

用户反馈：选中 Recording 后详情占满主区，「分类 / 场景」列表被遮住；上一轮
的「面包屑 + 返回」只解决了“知道自己在哪”，没有解决“列表还在不在”。本轮把窄栏
改成**明确的上下分栏**：列表永远是上栏，详情在下方展开、可收起，且详情有独立
滚动。只改客户端 `src/client/panel/**`，Host 接口、工具表和数据格式不变。

### 18.1 布局与尺寸

```
PanelApp (flex-col, h-full)
├─ header（项目选择 / 搜索 / 统计 + 根目录与数据提示，shrink-0）
└─ SidebarLayout（flex-1, min-h-0, flex-col）
   ├─ 上栏：asideContent（Tree / AllProjectsAside）
   │    flex-1 min-h-0 overflow-hidden；树自己的滚动容器继续负责滚动
   ├─ 分隔条（仅详情展开时）：10px 拖拽区 + 详情面板的 border-top
   ├─ 下栏：detail-pane（flex-basis 50%，min-h-0 flex-col）
   │    ├─ pane bar（28px）：`详情` 徽标 + 录制标题（truncate）+ 收起按钮
   │    └─ detail-pane-scroll（flex-1 overflow-y-auto overflow-x-hidden）
   │         └─ MainContent / RecordingDetail
   └─ footer（仅收起时）：32px「详情已收起 · <标题> [展开]」
```

- 下栏默认占上下分栏的 **50%**（落在设计要求的 45%–55%），上栏拿到其余高度；
  `max-height: calc(100% - 96px)` 保证上栏在任何窗口高度下都不小于 96px；
- 分隔条可拖拽（pointer capture），也可键盘操作：`↑/↓` 每次 ±5%，`Home/End`
  到 30% / 70%，双击回到 50%；范围 30%–70%，两侧都不会被拖没；
- 收起（pane bar 的 `收起详情`、详情里的 `← 返回`、或 `Esc`）只隐藏下栏，
  **不清空选中**：树上高亮、分类展开状态、树滚动位置都保留，列表拿到剩余全高，
  底部留一条 32px 恢复条；点击恢复条或再点一次该录制即可重新展开；
- 「全部项目」模式没有 Recording 详情可展开，上栏（项目列表 / 跨项目搜索结果）
  直接拿到全高，不再有下半屏的引导空态；
- 窄栏里详情头部不再 sticky（pane bar 已经显示录制标题），避免一个 ~150px 的
  头部吃掉 300px 高详情窗的一半；详情内容在 `detail-pane-scroll` 内独立滚动。

### 18.2 窄视口与页面变体

`PanelApp` 的 `variant="sidebar"` 走上述分栏；`variant="page"` 在 `< 768px`
（Tailwind `md` 断点，`window.matchMedia`）时也自动切到同一分栏，宽屏仍是
「左侧树 + 右侧详情」的并排布局。这样独立 `panel` 入口在 400px 下渲染的正是
DSH 右侧栏的真实布局（也是本轮截图的来源），桌面端不受影响。

`data-testid` 约定：`sidebar-split`（根，带 `data-detail-open`）、
`sidebar-split-list`、`detail-splitter`（`role=separator` + `aria-valuenow`）、
`detail-pane`、`detail-pane-bar`、`detail-pane-title`、`detail-pane-scroll`、
`detail-close`、`detail-reopen`。

### 18.3 键盘、返回与焦点

- `Esc`：先关详情（不退出选中），并 `focus()` 回树上选中的录制行，方向键可以继续
  在树里移动；输入框/重命名编辑器内、`defaultPrevented` 事件、以及打开的重跑/回收站
  确认框里都不抢 `Esc`；
- `← 返回` 在窄栏与 `Esc` 等价（关详情、保留选中）；宽屏页面变体仍是“返回列表空态”
  并清空选中，原有行为不变；
- 选中另一条录制时下栏直接换成新详情，树保持可见、可点击、可滚动。

### 18.4 测试与验证（2026-11-01）

- 新增 `tests/unit/panel/sidebar-layout.test.tsx`（6）：上下 DOM 顺序、`border-t`
  与独立滚动容器、分隔条 `aria-*`、键盘 ±5% / Home/End / 双击复位、pointer 拖拽与
  30%–70% 夹取、Esc 关闭且列表仍挂载、输入框/模态不抢 Esc、无详情时全高列表；
- `tests/unit/panel/view.test.tsx` 27 → **34**：列表 + 下方详情同时渲染、pane 标题、
  Runs 切换视频、切换录制更新详情、关闭/恢复条/选中保留、`返回` 关详情、
  Esc 后焦点回到选中行、树滚动位置保留、宽屏页面布局不变；
- 全量：`pnpm exec tsc --noEmit`、`pnpm exec vitest run`、`pnpm build` 通过；
  **517 passed | 3 skipped**；工具表仍为 **26**（纯客户端改动）。
- 真实 25 条录制的独立 `panel` 入口、400×1250 视口：`documentElement`、
  `panel-root`、`sidebar-split`、上/下栏、`detail-pane-scroll`、`tree-list`、
  `recording-detail`、`detail-header` 全部 `scrollWidth === clientWidth`
  （无横向滚动）；视频 `readyState=4` 可播放。

### 18.5 截图（真实数据 25 条录制，400px 宽）




> 截图取自独立只读 `panel` 入口（同一份真实 `.dsh/record-replay` 数据），400px 宽、
> DPR 2；不修改任何录制。独立入口没有回放服务，因此详情头部会显示禁用重跑的说明，
> DSH 宿主内不会出现。

### 18.6 重启要求

仅客户端改动：重新 `pnpm build` 后，刷新/重开 DSH 右侧栏面板即可
（`dist/panel` 与 `dist/client/client.js` 已重建）。不需要重启 DSH 宿主；桌面版
若窗口仍加载旧 bundle，重启 DSH 桌面应用一次即可（不需要重启独立 `panel` 命令，
它从 `dist/panel` 读静态文件，刷新页面就能拿到新 bundle）。
