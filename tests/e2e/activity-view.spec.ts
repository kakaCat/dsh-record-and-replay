import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const evidenceDir = path.resolve(process.cwd(), 'test-results/cua-evidence')

test.describe('Activity view prototype comparison', () => {
  test('matches authoritative prototype structure, filters and geometry', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/activity.html')

    await expect(page.getByRole('tab')).toHaveCount(3)
    await expect(page.getByTestId('tab-live')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[data-testid="step-row"]')).toHaveCount(7)

    await expect(page.getByTestId('filter-all')).toHaveText(/全部\s*7/)
    await expect(page.getByTestId('filter-success')).toHaveText(/成功\s*5/)
    await expect(page.getByTestId('filter-failure')).toHaveText(/失败\s*1/)

    const stepRowHeight = await page.locator('[data-testid="step-row"]').first().evaluate((element) => Math.round(element.getBoundingClientRect().height))
    expect(Math.abs(stepRowHeight - 72)).toBeLessThanOrEqual(1)

    await page.getByTestId('filter-failure').click()
    await expect(page.locator('[data-testid="step-row"]')).toHaveCount(1)
    await expect(page.getByTestId('filter-failure')).toHaveAttribute('data-active', 'true')

    await page.getByTestId('filter-all').click()
    await expect(page.locator('[data-testid="step-row"]')).toHaveCount(7)

    const cuaActionCount = await page.evaluate(() => {
      const state = (window as unknown as { __activityState?: { cuaActionCount: number } }).__activityState
      return state?.cuaActionCount ?? -1
    })
    expect(cuaActionCount).toBe(0)

    await mkdir(evidenceDir, { recursive: true })
    const screenshotPath = path.join(evidenceDir, 't10-1440.png')
    await page.screenshot({ path: screenshotPath, fullPage: true })

    const comparisonPath = path.join(evidenceDir, 't10-vs-prototype.md')
    await writeFile(comparisonPath, [
      '# t10 Activity View 原型对照',
      '',
      '- 截图：test-results/cua-evidence/t10-1440.png',
      '- 窗口：1440x900，chromium，inflight 活动视图',
      '- 一致项：3 个页签、7 个步骤行、全部/成功/失败筛选计数、72px 步骤行高、失败步骤 advice、只读状态计数。',
      '- 差异项：t10 使用本地 fixture DTO，录制库/回放报告页签为占位；尚未接入 Host Remote 实时事件。',
      '- 风险：当前只验证结构与几何，不验证 DSH Slot 内真实会话数据。',
      '',
    ].join('\n'), 'utf8')

    expect(screenshotPath).toContain('t10-1440.png')
    expect(comparisonPath).toContain('t10-vs-prototype.md')

    await page.getByTestId('tab-recordings').click()
    await expect(page.getByTestId('recordings-view')).toBeVisible()
    await expect(page.locator('[data-testid="recording-row"]')).toHaveCount(4)

    const interruptedButton = page.getByTestId('replay-recording').filter({ hasText: '仅可查看' }).first()
    await expect(interruptedButton).toHaveAttribute('aria-disabled', 'true')
    await expect(interruptedButton).toContainText('仅可查看')
    await expect(page.getByTestId('recording-detail')).toContainText('.dsh/record-and-replay/recordings/')

    const completedButton = page.getByTestId('replay-recording').filter({ hasText: '查看回放' }).first()
    await expect(completedButton).toHaveAttribute('aria-disabled', 'false')
    await completedButton.click()
    await expect(page.getByTestId('tab-replay')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('replay-view')).toContainText('来源 rec_')

    await expect(page.getByTestId('run-summary')).toContainText('15/20')
    await expect(page.getByTestId('run-summary')).toContainText('第 16 步起未执行')
    await expect(page.getByTestId('evidence-panel')).toContainText('step-015')
    await expect(page.getByTestId('evidence-panel')).toContainText('TARGET_NOT_FOUND')
    await expect(page.getByTestId('evidence-panel')).toContainText('已停止，未自动重试，原 Recording 未修改')
    await expect(page.locator('[data-testid="run-step-row"]')).toHaveCount(20)
    await expect(page.locator('[data-testid="run-step-row"][data-status="error"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="run-step-row"][data-status="skipped"]')).toHaveCount(5)

    const runStepRowHeight = await page.locator('[data-testid="run-step-row"]').first().evaluate((element) => Math.round(element.getBoundingClientRect().height))
    expect(Math.abs(runStepRowHeight - 72)).toBeLessThanOrEqual(1)

    const t12ScreenshotPath = path.join(evidenceDir, 't12-1440.png')
    await page.screenshot({ path: t12ScreenshotPath, fullPage: true })
    const t12ComparisonPath = path.join(evidenceDir, 't12-vs-prototype.md')
    await writeFile(t12ComparisonPath, [
      '# t12 Replay Report 原型对照',
      '',
      '- 截图：test-results/cua-evidence/t12-1440.png',
      '- 窗口：1440x900，chromium，replay report inflight 视图',
      '- 一致项：失败 Run 15/20、step-015、TARGET_NOT_FOUND、第 16 步起未执行、证据面板和 72px 行高。',
      '- 差异项：当前为 fixture Run 数据，未接入 ReplayService 实时查询；证据缩略图为占位。',
      '',
    ].join('\n'), 'utf8')

    await page.getByTestId('run-completed').click()
    await expect(page.getByTestId('run-summary')).toContainText('20/20')
    await expect(page.locator('[data-testid="run-step-row"][data-status="success"]')).toHaveCount(20)

    await page.getByTestId('tab-recordings').click()
    const sheetContentWidth = await page.getByTestId('activity-app').evaluate((element) => Math.round(element.getBoundingClientRect().width))
    expect(Math.abs(sheetContentWidth - 1180)).toBeLessThanOrEqual(1)

    const t11ScreenshotPath = path.join(evidenceDir, 't11-1440.png')
    await page.screenshot({ path: t11ScreenshotPath, fullPage: true })
    const t11ComparisonPath = path.join(evidenceDir, 't11-vs-prototype.md')
    await writeFile(t11ComparisonPath, [
      '# t11 Recording Library 原型对照',
      '',
      '- 截图：test-results/cua-evidence/t11-1440.png',
      '- 窗口：1440x900，chromium，recordings inflight 视图',
      '- 一致项：4 条 Recording、interrupted 仅可查看、completed 可进入回放、1180px sheet 宽度、存储路径说明。',
      '- 差异项：当前为 fixture 数据，未接入真实 RecordingService 列表；回放报告仍是 t12 占位。',
      '',
    ].join('\n'), 'utf8')

    const cuaActionCountAfterRecordings = await page.evaluate(() => {
      const state = (window as unknown as { __activityState?: { cuaActionCount: number } }).__activityState
      return state?.cuaActionCount ?? -1
    })
    expect(cuaActionCountAfterRecordings).toBe(0)
    expect(screenshotPath).toContain('t10-1440.png')
    expect(comparisonPath).toContain('t10-vs-prototype.md')
    expect(t11ScreenshotPath).toContain('t11-1440.png')
    expect(t11ComparisonPath).toContain('t11-vs-prototype.md')
    expect(t12ScreenshotPath).toContain('t12-1440.png')
    expect(t12ComparisonPath).toContain('t12-vs-prototype.md')
  })
})
