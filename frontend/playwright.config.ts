import { defineConfig } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';

const isCI = Boolean(process.env.CI);

if (!process.env.E2E_ADMIN_SEED) {
  process.env.E2E_ADMIN_SEED = Keypair.random().secret();
}
const e2eAdminPub = Keypair.fromSecret(process.env.E2E_ADMIN_SEED).publicKey();

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: isCI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    headless: true,
    channel: isCI ? undefined : 'msedge',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node ../backend/scripts/e2e-test-server.cjs',
      url: 'http://127.0.0.1:3001/health',
      reuseExistingServer: false,
      timeout: 20_000,
      env: {
        NODE_ENV: 'test',
        E2E_BACKEND_PORT: '3001',
        ADMIN_PUBLIC_KEYS: e2eAdminPub,
        ISSUER_PUBLIC_KEYS: e2eAdminPub,
      },
    },
    {
      command: 'npx vite --host 127.0.0.1 --port 5173',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        VITE_API_URL: 'http://127.0.0.1:3001/api',
      },
    },
  ],
});
