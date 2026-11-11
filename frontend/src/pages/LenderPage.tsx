import React, { useCallback, useEffect, useState } from 'react';
import { useWalletStore } from '../store/walletStore';
import { apiRequest } from '../services/api';
import { formatStroops } from '../config/stellar';
import { LoadingSpinner } from '../components/LoadingSpinner';

export function LenderPage() {
  const { publicKey, executeSignedTx } = useWalletStore();
  const [loading, setLoading] = useState(true);
  const [pool, setPool] = useState<any>(null);
  const [lenderBalance, setLenderBalance] = useState('0');
  const [depositAmt, setDepositAmt] = useState('250');
  const [withdrawAmt, setWithdrawAmt] = useState('50');
  const [error, setError] = useState<string | null>(null);

  const loadPool = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    setError(null);
    try {
      const [poolRes, balRes] = await Promise.all([
        apiRequest<{ data: any }>('/loans/pool'),
        apiRequest<{ data: { balanceFormatted: string } }>(`/loans/lender/${publicKey}`),
      ]);
      setPool(poolRes.data);
      setLenderBalance(balRes.data.balanceFormatted || '0');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load lender pool data');
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    void loadPool();
  }, [loadPool]);

  const handleDeposit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey) return;
    setError(null);
    try {
      await executeSignedTx({
        preparePath: '/loans/prepare-deposit',
        prepareBody: { lenderPublicKey: publicKey, amount: depositAmt },
        submitPath: '/loans/submit',
        submitBody: { action: 'deposit', borrowerPublicKey: publicKey, amount: depositAmt },
      });
      await loadPool();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pool deposit failed');
    }
  };

  const handleWithdraw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey) return;
    setError(null);
    try {
      await executeSignedTx({
        preparePath: '/loans/prepare-withdraw',
        prepareBody: { lenderPublicKey: publicKey, amount: withdrawAmt },
        submitPath: '/loans/submit',
        submitBody: { action: 'withdraw', borrowerPublicKey: publicKey, amount: withdrawAmt },
      });
      await loadPool();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pool withdrawal failed');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Lender Liquidity Pool</h1>
        <p className="text-sm text-slate-600">
          Supply SEP-41 loan tokens into the shared underwriting pool and earn amortized interest
          yield proportional to your pool shares.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10">
          <LoadingSpinner size="lg" />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-medium uppercase text-slate-500">Your Pool Value</div>
            <div className="mt-2 text-2xl font-bold text-indigo-700">{lenderBalance} XLM</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-medium uppercase text-slate-500">Available Cash</div>
            <div className="mt-2 text-2xl font-bold text-emerald-700">
              {pool?.availableCash ?? '0'} XLM
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-medium uppercase text-slate-500">
              Outstanding Principal
            </div>
            <div className="mt-2 text-2xl font-bold text-slate-900">
              {pool?.outstandingPrincipal ?? '0'} XLM
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-medium uppercase text-slate-500">
              Interest Earned (Pool)
            </div>
            <div className="mt-2 text-2xl font-bold text-slate-900">
              {formatStroops(pool?.totalInterestEarnedStroops)} XLM
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <form
          onSubmit={handleDeposit}
          className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <h2 className="text-base font-semibold text-slate-900">Deposit Liquidity</h2>
          <p className="mt-1 text-xs text-slate-600">
            Mints proportional pool shares backed by on-chain pool reserves.
          </p>
          <input
            type="text"
            value={depositAmt}
            onChange={(e) => setDepositAmt(e.target.value)}
            placeholder="Deposit amount (XLM)"
            className="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            required
          />
          <button
            type="submit"
            className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            Deposit &amp; Sign in Freighter
          </button>
        </form>

        <form
          onSubmit={handleWithdraw}
          className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <h2 className="text-base font-semibold text-slate-900">Withdraw Liquidity</h2>
          <p className="mt-1 text-xs text-slate-600">
            Redeem uncommitted available pool cash up to your current share balance.
          </p>
          <input
            type="text"
            value={withdrawAmt}
            onChange={(e) => setWithdrawAmt(e.target.value)}
            placeholder="Withdraw amount (XLM)"
            className="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            required
          />
          <button
            type="submit"
            className="mt-4 rounded-lg border border-slate-300 bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Withdraw &amp; Sign in Freighter
          </button>
        </form>
      </div>
    </div>
  );
}
