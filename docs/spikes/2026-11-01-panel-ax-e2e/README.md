# 录放面板：默认项目 + 双击编辑 AX 实测（2026-11-01）

目标：验证右侧栏面板不再默认落到 `desktop` profile，并在有录制的项目上
用 Cua 桌面工具/AX 实测「双击分类 / 双击未分组 / 双击场景」的编辑路径。

## 环境

- 仓库：`<workspace>`
- 构建：`pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build`
  - 测试：**436 passed | 3 skipped**
  - 构建：`dist/index.mjs`、`dist/client/client.js`、`dist/panel/*` 更新
- 不改动当前会话所在的 DSH 桌面进程（宿主模块图有缓存，重启会打断会话），
  另起一个 DSH Web 实例加载**同一个 desktop profile**（`node_modules` 链接
  指向本仓库，`DSH_HOME` 为临时目录、复用 workspace.json 副本），
  用 Chrome + Cua 桌面 AX 驱动：
  - 创建/编辑验证：`http://127.0.0.1:59731`（中间构建）
  - 最终构建的默认项目复验：`http://127.0.0.1:59733`（干净 origin，无 localStorage）
- Cua 用法：每个流程都在**一次** `run_script` 里 `getState/query` 后立刻
  `click/setValue`，不复用跨调用的 element_token（token 每次快照都会变）。

## 结果摘要

### 1. 全新 origin 默认项目 = 有录制的仓库

干净 origin（59733，最终构建）打开 New Session → Record & Replay：

```text
AXComboBox "选择项目" = "dsh-record-and-replay 25 录制"
AXStaticText = "<workspace>"
AXButton "B站 9" [help="双击重命名分类"]
AXButton "B站搜索：明日方舟周年庆 v2 有视频 3 步 2 Run 11/01 12:47 完成"
```

第一次打开就落到 `dsh-record-and-replay`（唯一有录制的项目），没有出现
`desktop` / `dsh-superagent-prototype` 的空态。截图：本地证据，未随公开仓库发布。




> 默认规则：上次选中 → 当前会话工作区（有录制时）→ 独立命令 cwd →
> 第一个有录制 → 第一个项目。DSH 宿主以 `cwd: null` 构造 `PanelService`，
> 因此 profile/启动目录不会进入候选。

### 2. 双击「B站」出现内联输入框

```text
AXButton "B站 9" [help="双击重命名分类"]
→ 双击
AXTextField "分类名称 B站" = "B站"
```

按 Escape 取消，未写 `index.json`（只验证输入框出现）。

### 3. 双击「未分组」→ 新建场景并收纳

中间构建（59731）上，B站下 9 条录制都在未分组：

```text
AXButton "未分组 9" [help="双击新建场景并收纳未分组录制"]
→ 双击
AXHeading "新建场景并收纳当前 9 条录制"
AXStaticText = "场景名称"
AXTextField "新场景名称" = "例如：登录流程"
AXButton "取消"
AXButton "创建"
```

输入「明日方舟周年庆」并点「创建」后，树刷新为：

```text
AXButton "明日方舟周年庆 9" [help="双击重命名场景"]
AXButton "B站搜索：明日方舟周年庆 v2 有视频 3 步 2 Run 11/01 12:47 完成"
```

截图：本地证据，未随公开仓库发布。


### 4. 双击场景出现内联输入框（最终构建复验）

最终构建（59733）上：

```text
AXButton "明日方舟周年庆 9" [help="双击重命名场景"]
→ 双击
AXTextField "场景名称 明日方舟周年庆" = "明日方舟周年庆"
```

按 Escape 取消（名称未变）。

### 5. index.json 写入，manifest 字节不变

`index-before.json` / `index-after.json` 与本目录两份 `hashes-*.txt` 可复核：

```text
index.json            21362432…5a2a21  →  b4dc3f7f…964d26
rec_c2dbb8…manifest   06940019…f52c475 →  06940019…f52c475  （不变）
rec_5f1e07…manifest   b246c514…d5d74ab →  b246c514…d5d74ab  （不变）
```

新增内容：

```json
{
  "id": "scn_89bb1ad974",
  "categoryId": "bilibili",
  "name": "明日方舟周年庆"
}
```

以及 9 条 `"scenarioId": "scn_89bb1ad974"` 的 assignment（原有 intent 保留）。

### 6. 其它 AX 证据

- 「打开文件夹」按钮存在：
  `AXButton "打开文件夹" [help="打开文件夹…（记住最近打开）"]`。
  点击后该按钮在 AX 中变为无 `actions`/无 `help` 的 pending 态，说明
  `ctx.uiWorkspace.pickDirectory()` 已被调用并等待用户选择；本次临时 Web
  实例没有完成目录选择（避免改动本机目录），选中后的注册路径由
  `view.test.tsx` 的文件夹选择用例与 `fetch-api.test.ts` 的 `POST /root`
  用例覆盖。选中后会 POST 注册并记到 `~/.dsh/record-replay-panel.json`。
- 空态区分：`PANEL_ROOT_NOT_FOUND` → 「项目不存在」；项目存在但无录制 →
  「这个项目还没有录制」（带项目名与根路径）。

## 重启说明

- **宿主侧改动（`src/panel/*`、`src/plugin/index.ts`）需要重启 DSH**，
  只刷新窗口只能加载新的客户端 bundle；
- 本次 e2e 使用的第二个 DSH 实例验证了新构建，当前桌面实例仍运行旧宿主代
  码，因此用户侧需要重启/重开桌面应用后才会看到修复；
- 独立 `panel` 命令需 `pnpm build` 后重新启动。
