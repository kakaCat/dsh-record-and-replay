# 用 launchd 每晚跑一条 Web suite

本文给出一个 macOS launchd 示例：每晚用独立 CLI 回放一条 Web suite，输出 JUnit
XML，失败时发系统通知。CLI 不启动 DSH，但会复用同一份 `.dsh/record-replay`
录制库与回放实现。

## 重要：launchd 的 PATH 很窄

launchd 启动的进程只有 `/usr/bin:/bin:/usr/sbin:/sbin`，`node` 和 `cua-driver` 通常都不在其中。实测第一次会报：

```
error: Cua driver unavailable (CUA_CAPABILITY_MISSING): spawn cua-driver ENOENT
```

wrapper 里必须显式补 PATH（并建议用绝对路径调用 node）：

```bash
#!/bin/bash
export PATH="$(dirname "$(command -v cua-driver)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd /path/to/repo || exit 2
/absolute/path/to/node dist/cli.mjs test tests/suites/web-login.json --launch isolated --timeout 120000 --junit /tmp/web-login.xml
```

## 前置

1. 已安装并授权 Cua：

   ```bash
   cua-driver --version   # >= 0.38.0
   ```

   `existing` 绑定需要 Cua daemon 已获得系统权限；`isolated` 由 Cua 自己启动临时
   Chromium，仍需要屏幕录制权限才能产出视频。

2. 仓库已构建：

   ```bash
   cd /Users/you/work/dsh-record-and-replay
   pnpm install
   pnpm build
   node dist/cli.mjs --help
   ```

3. suite 已存在，例如 `tests/suites/web-login.json`。先手动跑通一次：

   ```bash
   node dist/cli.mjs test tests/suites/web-login.json --launch isolated \
     --junit /tmp/web-login.junit.xml
   echo $?   # 0 = 全部 completed
   ```

4. 账号密码放 macOS Keychain，不要写进 plist：

   ```bash
   security add-generic-password \
     -s dsh-replay-saucedemo -a standard_user \
     -w 'secret_sauce' -U
   ```

   > `--values` 是进程参数，运行期间本机其他用户可能通过 `ps` 看到。单用户机器
   > 可以接受；共享机器上请把 wrapper 的权限收紧，或改用专门的测试账号。

## 1. wrapper 脚本

launchd 不展开 `~`，也不会加载你的 shell 配置；脚本里统一用绝对路径。
把下面内容保存为 `/Users/you/work/dsh-record-and-replay/scripts/run-web-suite.sh`：

```bash
#!/bin/zsh
set -u

REPO="/Users/you/work/dsh-record-and-replay"
NODE="/Users/you/.local/bin/node"
ARTIFACTS="$HOME/Library/Logs/dsh-record-replay"
mkdir -p "$ARTIFACTS"
cd "$REPO" || exit 2

password="$(/usr/bin/security find-generic-password \
  -s dsh-replay-saucedemo -a standard_user -w 2>/dev/null)" || {
  echo "missing Keychain item dsh-replay-saucedemo (account standard_user)" >&2
  exit 2
}

"$NODE" "$REPO/dist/cli.mjs" test "$REPO/tests/suites/web-login.json" \
  --launch isolated \
  --timeout "${TIMEOUT_MS:-120000}" \
  --values step_3404b5e3658b4dd68763fd42923dc267=standard_user \
  --values step_4c6caa140dfd40a3bc97e2bc2af69a49="$password" \
  --junit "$ARTIFACTS/web-login.junit.xml"
status=$?

if [ "$status" -ne 0 ]; then
  /usr/bin/osascript -e \
    "display notification \"dsh-record-replay failed (exit $status)\" with title \"Nightly web suite\""
fi

# 0 = 全部通过；1 = 有用例失败；2 = 配置/Cua/套件错误。
exit "$status"
```

```bash
chmod +x scripts/run-web-suite.sh
```

`osascript` 通知需要系统通知权限；如果 CI 机器上没人登录 GUI，改成写邮件、Slack
webhook 或 `terminal-notifier` 都可以，判断条件仍然是 `status -ne 0`。

`--timeout`（毫秒，默认 `120000`）是**每条 case** 的预算：超时后用 `cancelRun`
中止该 Run，记 `RUN_TIMEOUT` 并继续下一条，因此一次卡死不会拖住整晚任务。
也可以写在 suite / case 的 `timeoutMs` 里；优先级是 case → 命令行 → suite → 默认值。
launchd 环境里需要更宽的预算时，改 wrapper 里的 `TIMEOUT_MS` 或给每条 case 单独设置。

## 2. LaunchAgent plist

保存为 `~/Library/LaunchAgents/com.example.dsh-record-replay.nightly.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.dsh-record-replay.nightly</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>/Users/you/work/dsh-record-and-replay/scripts/run-web-suite.sh</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/you/work/dsh-record-and-replay</string>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>2</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/you/.local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/dsh-record-replay/nightly.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/dsh-record-replay/nightly.err.log</string>

  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
```

`PATH` 必须包含 `cua-driver` 与 `ffmpeg`；否则 CLI 会以 exit 2 报
`Cua driver unavailable`。wrapper 里用的是绝对路径 `node`，所以不依赖 PATH 找
Node。

## 3. 安装、立即跑一次

```bash
mkdir -p ~/Library/Logs/dsh-record-replay
plutil -lint ~/Library/LaunchAgents/com.example.dsh-record-replay.nightly.plist

launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.example.dsh-record-replay.nightly.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.dsh-record-replay.nightly.plist
launchctl kickstart -k gui/$(id -u)/com.example.dsh-record-replay.nightly
```

查看状态与日志：

```bash
launchctl print gui/$(id -u)/com.example.dsh-record-replay.nightly | head -40
tail -n 50 ~/Library/Logs/dsh-record-replay/nightly.log
tail -n 50 ~/Library/Logs/dsh-record-replay/nightly.err.log
```

停用：

```bash
launchctl bootout gui/$(id -u)/com.example.dsh-record-replay.nightly
```

## 4. 结果与排障

- JUnit：`~/Library/Logs/dsh-record-replay/web-login.junit.xml`；失败用例是
  `<failure message="...">`。
- 运行数据：`<仓库>/.dsh/record-replay/recordings/<recordingId>/runs/<runId>/`
  - `run.json`、`steps.jsonl`、`evidence/`
  - 视频（默认开）：`runs/<runId>/video/replay.webm`
- 退出码：
  - `0` 全部 `completed`；
  - `1` 至少一条用例失败（JUnit 里能看到 failure）；
  - `2` 参数、suite JSON、Cua 连接或工作区装配失败，属于基础设施问题。
- 常见 exit 2：
  - `spawn cua-driver ENOENT` → plist 的 `PATH` 没包含 Cua；
  - `Cua driver version ... is not supported` → 升级到 `>= 0.38.0`；
  - `cannot read suite` / `invalid suite` → 检查 plist 里的绝对路径和 JSON；
  - ffmpeg 没权限时回放仍可成功，只是没有视频（Screen Recording 授权给运行
    launchd agent 的进程）。
- 视频保留策略跟随 HostConfig 默认值：每个 recording 保留最近 50 个成功 Run 的
  视频（`replay.videoMaxRuns`）。长期运行请定期清理 `.dsh/` 或调小该值（CLI 目前
  固定使用默认 HostConfig）。

## 5. 多套件

同一个 wrapper 里顺序跑多条 suite 即可，任意一条非 0 就累计失败状态：

```bash
overall=0
for suite in tests/suites/web-login.json tests/suites/web-assert-fail.json; do
  "$NODE" "$REPO/dist/cli.mjs" test "$REPO/$suite" --launch isolated \
    --junit "$ARTIFACTS/$(basename "$suite" .json).junit.xml" || overall=$?
done
[ "$overall" -eq 0 ] || /usr/bin/osascript -e 'display notification "suite failed"'
exit "$overall"
```

（`web-assert-fail.json` 是故意失败的负向样例，不要放进日常任务。）
