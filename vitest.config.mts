import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Tests share one Postgres database, so run files sequentially.
    fileParallelism: false,
    globalSetup: ['./tests/global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Tests always run against dev auth, a fake Paystack key (the network is stubbed) and local storage, whatever server/.env says.
    env: { NODE_ENV: 'test', AUTH_MODE: 'dev', PAYSTACK_SECRET_KEY: 'sk_test_unit_test_secret', CREDIT_PRICE_KOBO: '50000', STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: './storage-test', MIN_PAYOUT_KOBO: '100000', PAYOUT_HOLD_DAYS: '7', DEMO_AUTO_VERIFY: 'false' },
  },
})
