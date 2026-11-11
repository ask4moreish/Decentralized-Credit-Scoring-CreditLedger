import { test, expect, Page } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';

async function attachMockFreighter(page: Page, kp: Keypair) {
  await page.exposeFunction('e2eSignChallenge', (challenge: string) =>
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
          window as unknown as { e2eSignChallenge: (c: string) => Promise<string> }
        ).e2eSignChallenge(challenge);
        return { signedMessage: sigHex, signerAddress: publicKey };
      },
      signTransaction: async (xdr: string) => ({
        signedTxXdr: `SIGNED::${xdr}`,
        signerAddress: publicKey,
      }),
    };
  }, kp.publicKey());
}

test.describe('CreditLedger Full-Stack Browser E2E Flows', () => {
  test('Freighter Ed25519 login -> Lender Pool -> Loan Apply -> Admin Disburse -> Repay -> Privacy -> Vouch', async ({
    browser,
  }) => {
    const userKp = Keypair.random();
    const peerKp = Keypair.random();
    const adminKp = Keypair.fromSecret(process.env.E2E_ADMIN_SEED || '');

    const userContext = await browser.newContext();
    const page = await userContext.newPage();
    await attachMockFreighter(page, userKp);

    // 1. Landing -> Connect Wallet -> Real Ed25519 Auth -> Dashboard
    await page.goto('/');
    await expect(page.getByText(/Attestation-Backed Credit Scoring/i)).toBeVisible();
    await page.getByRole('link', { name: /Connect Wallet to Start/i }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.getByRole('button', { name: 'lender', exact: true }).click();
    await page.getByRole('button', { name: /Connect & Sign with Freighter/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText('84 / 100')).toBeVisible();

    // 2. Lender Liquidity Pool Deposit
    const nav = page.getByRole('navigation');
    await nav.getByRole('link', { name: 'Lender Pool' }).click();
    await expect(page).toHaveURL(/\/lender/);
    await expect(page.getByText('5000 XLM')).toBeVisible();
    await page.getByPlaceholder('Deposit amount (XLM)').fill('250');
    await page.getByRole('button', { name: /Deposit & Sign in Freighter/i }).click();
    await expect(page.getByTestId('tx-status-banner')).toHaveAttribute('data-stage', 'confirmed');
    await expect(page.getByText('250 XLM', { exact: true })).toBeVisible();
    await expect(page.getByText('5250 XLM', { exact: true })).toBeVisible();

    // 3. Borrower Loan Application -> Pending status shown
    await nav.getByRole('link', { name: 'Loans' }).click();
    await expect(page).toHaveURL(/\/loans/);
    await page.getByRole('button', { name: /Check Eligibility & LTV Collateral/i }).click();
    await expect(page.getByText(/Eligible:/)).toBeVisible();

    await page.getByRole('button', { name: /Prepare & Sign Loan Application/i }).click();
    await expect(page.getByText(/Loan #1/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Cancel Pending/i })).toBeVisible();

    // 4. Separate Admin Context approves & disburses Loan #1 via /admin UI
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await attachMockFreighter(adminPage, adminKp);
    await adminPage.goto('/login');
    await adminPage.getByRole('button', { name: /Connect & Sign with Freighter/i }).click();
    await expect(adminPage).toHaveURL(/\/dashboard/);
    await adminPage.getByRole('navigation').getByRole('link', { name: 'Admin / Issuer' }).click();
    await expect(adminPage).toHaveURL(/\/admin/);
    await adminPage.getByRole('button', { name: /Approve & Disburse/i }).click();
    await expect(adminPage.getByText(/Loan approved and principal disbursed/i)).toBeVisible();
    await adminContext.close();

    // 5. Borrower reloads Loans & repays disbursed active Loan #1
    await page.reload();
    await page.getByPlaceholder('Amount XLM').fill('100');
    await page.getByRole('button', { name: 'Repay', exact: true }).click();
    await expect(page.getByText('repaid', { exact: true })).toBeVisible();

    // 6. Credit Score Breakdown, Zero-Weight Supplementary Anchor, Selective Consent & Revocation
    await nav.getByRole('link', { name: 'Credit Score' }).click();
    await expect(page).toHaveURL(/\/credit-score/);
    await expect(page.getByText('84 / 100')).toBeVisible();

    await page.getByRole('button', { name: /Prepare & Sign Commitment Anchor/i }).click();
    await expect(
      page.getByText(/Supplementary commitment anchored on-chain \(0% authoritative weight\)/i)
    ).toBeVisible();

    await page.getByPlaceholder(/Grantee Stellar Public Key/i).fill(peerKp.publicKey());
    await page.getByRole('button', { name: /Grant Selective Consent/i }).click();
    await expect(page.getByText(/Selective disclosure consent created:/i)).toBeVisible();
    await page.getByRole('button', { name: /Revoke Latest Grant/i }).click();
    await expect(page.getByText(/revoked\./i)).toBeVisible();

    // 7. Community Vouch Escrow Creation & Revocation (no spoofable trustScore input)
    await nav.getByRole('link', { name: 'Vouch' }).click();
    await expect(page).toHaveURL(/\/vouch/);
    await expect(page.getByPlaceholder(/Trust Score/i)).toHaveCount(0);
    await page.getByPlaceholder('G...').fill(peerKp.publicKey());
    await page.getByRole('button', { name: /Stake & Sign Vouch in Freighter/i }).click();
    await expect(page.getByText(/Vouch #1/)).toBeVisible();
    await page.getByRole('button', { name: /Revoke & Refund/i }).click();
    await expect(page.getByTestId('tx-status-banner')).toHaveAttribute('data-stage', 'confirmed');

    await userContext.close();
  });
});
