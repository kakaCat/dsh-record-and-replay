# 项目说明书：Cua Driver 浏览器 Record/Replay

本项目实现 DSH 侧的 Cua Driver-only 浏览器录制与回放基线：Agent 通过 Host 工具操作 Chrome/Edge，录制动作、脱敏落盘，再对 completed Recording 做语义重放。V1 明确不使用 `dsh_browser` 执行链路，也不启用未验证的 Cua Native Transport。

## 当前认知

- 运行基线：macOS、Node 22、Cua Driver 0.38.0、Chrome/Edge、持久 MCP 连接。
- 核心模块：`src/core`、`src/cua`、`src/driver`、`src/host`、`src/recording`、`src/store`、`src/replay`、`src/client`、`src/testing`。
- 存储布局：`.dsh/record-and-replay/recordings/<recordingId>/{manifest.json,steps.jsonl,assets/,runs/}`。
- 回放边界：只执行 completed Recording；失败即停；来源 Recording sha256 不变；写动作发送后不自动重试。
- 已知限制：UI 为静态客户端 fixture，尚未接入 DSH Host Remote 实时数据；右侧栏 webview 未验收。

## 验证入口

```text
pnpm exec tsc --noEmit
pnpm test
pnpm exec playwright test tests/e2e/activity-view.spec.ts --project=chromium
CUA_E2E=1 pnpm test -- tests/e2e/cua-browser.spec.ts
```
