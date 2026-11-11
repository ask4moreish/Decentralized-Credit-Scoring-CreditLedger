import { test, expect } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';

test.describe('Frontend Edge Cases, Wallet Declines, Session Expiry & RBAC', () => {
  test('aborts login cleanly with role=alert when Freighter user declines challenge signature', async ({
    page,
  }) => {
    const kp = Keypair.random();
    await page.addInitScript((publicKey: string) => {
      (window as unknown as { __FREIGHTER_TEST_BRIDGE__: unknown }).__FREIGHTER_TEST_BRIDGE__ = {
        isConnected: async () => ({ isConnected: true }),
        requestAccess: async () => ({ address: publicKey }),
        getAddress: async () => ({ address: publicKey }),
        getNetworkDetails: async () => ({
          network: 'TESTNET',
          networkPassphrase: 'Test SDF Network ; September 2015',
        }),
        signMessage: async () => {
          throw new Error('User declined message signature in Freighter.');
        },
        signTransaction: async () => {
          throw new Error('User declined transaction signature in Freighter.');
        },
      };
    }, kp.publicKey());

    await page.goto('/login');
    await page.getByRole('button', { name: /Connect & Sign with Freighter/i }).click();

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('alert')).toContainText(/declined/i);
  });

  test('blocks standard borrower from Admin UI, surfaces declined tx error banner, and handles 401 session expiry', async ({
    page,
  }) => {
    const kp = Keypair.random();
    await page.exposeFunction('negSignChallenge', (challenge: string) =>
      kp.sign(Buffer.from(challenge, 'utf8')).toString('hex')
    );
    await page.addInitScript((publicKey: string) => {
      (window as unknown as { __FREIGHTER_TEST_BRIDGE__: unknown }).__FREIGHTER_TEST_BRIDGE__ = {
        isConnected: async () => ({ isConnected: true }),
        requestAccess: async () => ({ address: publicKey }),
        getAddress: async () => ({ address: publicKey }),
        getNetworkDetails: async () => ({
          network: 'TESTNET',
          networkPassphrase: 'Test SDF Network ; September 2015',
        }),
        signMessage: async (challenge: string) => {
          const sigHex = await (
            window as unknown as { negSignChallenge: (c: string) => Promise<string> }
          ).negSignChallenge(challenge);
          return { signedMessage: sigHex, signerAddress: publicKey };
        },
        signTransaction: async () => {
          throw new Error('Transaction rejected by user in Freighter popup.');
        },
      };
    }, kp.publicKey());

    await page.goto('/login');
    await page.getByRole('button', { name: /Connect & Sign with Freighter/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    // 1. Standard borrower has no Admin link and direct /admin navigation renders RBAC restriction
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Admin / Issuer' })).toHaveCount(0);
    await page.goto('/admin');
    await expect(page.getByText(/Access restricted: requires Admin or Authorized Issuer role/i)).toBeVisible();

    // 2. Freighter tx rejection transitions TxStatusBanner cleanly to error stage without crashing UI
    await page.getByRole('navigation').getByRole('link', { name: 'Loans' }).click();
    await expect(page).toHaveURL(/\/loans/);
    await page.getByRole('button', { name: /Prepare & Sign Loan Application/i }).click();
    await expect(page.getByTestId('tx-status-banner')).toHaveAttribute('data-stage', 'error');
    await expect(page.getByTestId('tx-status-banner')).toContainText(/Transaction rejected by user/i);

    // 3. Simulate expired access + revoked refresh session (401 -> redirect back to /login)
    await page.route('**/api/loans/user/*', async (route) => {
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Expired"}' });
    });
    await page.route('**/api/auth/refresh', async (route) => {
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Revoked"}' });
    });
    await page.goto('/loans');
    await expect(page).toHaveURL(/\/login/);
  });
});
