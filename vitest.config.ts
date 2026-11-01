import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // M0 spikes are executable scripts with their own environment/acceptance;
    // they must not be collected as zero-test vitest suites.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/spikes/**', 'tests/e2e/activity-view.spec.ts'],
  },
})
