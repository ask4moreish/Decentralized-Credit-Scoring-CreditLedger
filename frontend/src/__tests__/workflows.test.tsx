import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useWalletStore } from '../store/walletStore';
import * as freighter from '../services/freighter';
import { LoansPage } from '../pages/LoansPage';
import { LenderPage } from '../pages/LenderPage';
import { VouchPage } from '../pages/VouchPage';
import { CreditScorePage } from '../pages/CreditScorePage';
import { AdminPage } from '../pages/AdminPage';

describe('CreditLedger Workflow UI Components', () => {
  const pubKey = 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';

  beforeEach(() => {
    vi.restoreAllMocks();
    useWalletStore.setState({
      isConnected: true,
      publicKey: pubKey,
      token: 'jwt-valid',
      refreshToken: 'ref-valid',
      role: 'borrower',
      roles: ['borrower', 'lender'],
      isAdmin: false,
      txState: { stage: 'idle' },
    });
  });

  it('LoansPage checks eligibility and displays collateral requirements & loans cleanly', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/loans/user/')) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              data: {
                loans: [
                  {
                    id: 11,
                    amount: '5000000000',
                    interest_rate: 15,
                    duration_months: 6,
                    status: 'active',
                    repaid_amount: '0',
                    collateral_amount: '6250000000',
                    collateral_locked: true,
                  },
                ],
              },
            }),
        } as Response;
      }
      if (url.includes('/loans/check-eligibility')) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              data: {
                canBorrow: true,
                creditScore: 55,
                collateralRequired: true,
                requiredCollateralFormatted: '125',
                reasons: [],
              },
            }),
        } as Response;
      }
      return { ok: true, text: async () => '{}' } as Response;
    });

    render(
      <MemoryRouter>
        <LoansPage />
      </MemoryRouter>
    );

    expect(await screen.findByText(/Loan #11/)).toBeTruthy();
    expect(screen.getByText(/625 XLM \(Locked\)/)).toBeTruthy();

    fireEvent.click(screen.getByText(/Check Eligibility & LTV Collateral/));
    expect(await screen.findByText(/Required Collateral:/)).toBeTruthy();
    expect(screen.getByText(/125 XLM/)).toBeTruthy();
  });

  it('LenderPage displays shared pool reserves & executes deposit liquidity signing', async () => {
    vi.spyOn(freighter, 'getFreighterNetworkPassphrase').mockResolvedValue(
      'Test SDF Network ; September 2015'
    );
    const signSpy = vi.spyOn(freighter, 'signSorobanXdr').mockResolvedValue('SIGNED_DEP_XDR');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/loans/pool')) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              data: {
                availableCash: '1200',
                outstandingPrincipal: '400',
                totalInterestEarnedStroops: '150000000',
              },
            }),
        } as Response;
      }
      if (url.includes('/loans/lender/')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ data: { balanceFormatted: '300' } }),
        } as Response;
      }
      if (url.endsWith('/loans/prepare-deposit')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ xdr: 'UNSIGNED_DEP_XDR' }),
        } as Response;
      }
      if (url.endsWith('/loans/submit')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ success: true, transactionHash: 'dep_tx_99', ledger: 12 }),
        } as Response;
      }
      return { ok: true, json: async () => ({ balances: [] }) } as Response;
    });

    render(
      <MemoryRouter>
        <LenderPage />
      </MemoryRouter>
    );

    expect(await screen.findByText('300 XLM')).toBeTruthy();
    expect(screen.getByText('1200 XLM')).toBeTruthy();

    fireEvent.click(screen.getByText(/Deposit & Sign in Freighter/));
    await waitFor(() => {
      expect(signSpy).toHaveBeenCalled();
    });
    expect(useWalletStore.getState().txState.txHash).toBe('dep_tx_99');
  });

  it('VouchPage omits caller-spoofable trustScore field and renders escrow & revoke buttons', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          data: [
            {
              id: 3,
              voucher_key: pubKey,
              vouchee_key: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674GB',
              amount: '500000000',
              escrowed_balance: '500000000',
              slashed_amount: '0',
              trust_score: 82,
              reason: 'Trade partner',
              is_active: true,
              withdrawn: false,
            },
          ],
        }),
    } as Response);

    render(
      <MemoryRouter>
        <VouchPage />
      </MemoryRouter>
    );

    expect(await screen.findByText(/Vouch #3/)).toBeTruthy();
    expect(screen.getByText(/Policy Trust Weight: 82/)).toBeTruthy();
    expect(screen.queryByPlaceholderText(/Trust Score/i)).toBeNull();
    expect(screen.getByText(/Revoke & Refund/)).toBeTruthy();
  });

  it('CreditScorePage shows 5-pillar score, 0% weight warning, and inline erasure confirmation', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/breakdown')) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              data: {
                modelVersion: 2,
                overallScore: 84,
                defaultPenalty: 0,
                pillars: {
                  paymentHistory: { score: 90, weightPct: 35 },
                  savings: { score: 80, weightPct: 25 },
                  repayment: { score: 85, weightPct: 20 },
                  community: { score: 75, weightPct: 10 },
                  activity: { score: 70, weightPct: 10 },
                },
              },
            }),
        } as Response;
      }
      if (url.endsWith('/trends')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ data: { change: 4, snapshots: [] } }),
        } as Response;
      }
      if (url.endsWith('/records')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ data: { records: [] } }),
        } as Response;
      }
      if (url.endsWith('/privacy') && init?.method === 'DELETE') {
        return {
          ok: true,
          text: async () => JSON.stringify({ success: true, deletedRecords: 2 }),
        } as Response;
      }
      return { ok: true, text: async () => '{}' } as Response;
    });

    render(
      <MemoryRouter>
        <CreditScorePage />
      </MemoryRouter>
    );

    expect(await screen.findByText('84 / 100')).toBeTruthy();
    expect(screen.getByText(/0% Score Weight/)).toBeTruthy();

    fireEvent.click(screen.getByText(/Erase Off-Chain Private Data/));
    fireEvent.click(await screen.findByText(/Confirm Delete/));
    expect(await screen.findByText(/Erased 2 off-chain encrypted record/)).toBeTruthy();
  });

  it('AdminPage enforces role gate cleanly and loads governance queue for admin', async () => {
    const { rerender } = render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>
    );
    expect(screen.getByText(/Access restricted/)).toBeTruthy();

    useWalletStore.setState({ isAdmin: true, role: 'admin', roles: ['admin', 'issuer'] });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/loans/admin/active')) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              data: {
                loans: [{ id: 1, status: 'pending', borrower_public_key: pubKey, amount: '1000000000', credit_score_used: 85 }],
              },
            }),
        } as Response;
      }
      return { ok: true, text: async () => JSON.stringify({ data: {} }) } as Response;
    });

    rerender(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>
    );
    expect(await screen.findByText(/Loan #1 \(pending\)/)).toBeTruthy();
    expect(screen.getByText(/Approve & Disburse/)).toBeTruthy();
  });

  it('surfaces accessible error alert banner when collateral or Freighter tx preparation fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/loans/user/')) {
        return { ok: true, text: async () => JSON.stringify({ data: { loans: [] } }) } as Response;
      }
      if (url.includes('/loans/prepare-apply')) {
        return {
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({ error: 'Base tier score requires >= 125% collateral (500 XLM).' }),
        } as Response;
      }
      return { ok: true, text: async () => '{}' } as Response;
    });

    render(
      <MemoryRouter>
        <LoansPage />
      </MemoryRouter>
    );

    await screen.findByText(/Apply for a Loan/);
    fireEvent.click(screen.getByRole('button', { name: /Prepare & Sign Loan Application/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/125% collateral/i);
    expect(useWalletStore.getState().txState.stage).toBe('error');
  });
});
