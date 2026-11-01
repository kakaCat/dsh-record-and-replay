import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /activity-view\.spec\.ts/,
  globalSetup: './tests/e2e/playwright.global-setup.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'ACTIVITY_SERVER_AUTOSTART=1 pnpm exec tsx tests/e2e/activity-server.ts',
    url: 'http://127.0.0.1:4173/activity.html',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
