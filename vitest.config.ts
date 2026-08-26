import { defineConfig, configDefaults } from 'vitest/config'

// The e2e criteria suite drives real Chrome, so it is excluded from the default
// run. `npm run test:e2e` passes `tests/e2e` on the command line, which opts it
// back in — an exclude glob would otherwise win over that filter.
const wantsE2e = process.argv.slice(2).some((a) => a.includes('tests/e2e'))

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: wantsE2e ? [...configDefaults.exclude] : [...configDefaults.exclude, 'tests/e2e/**'],
    environment: 'node',
  },
})
