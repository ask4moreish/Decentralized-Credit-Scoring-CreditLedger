import React, { useCallback, useEffect, useState } from 'react';
import { useWalletStore } from '../store/walletStore';
import { apiRequest } from '../services/api';
import { formatStroops } from '../config/stellar';
import { LoadingSpinner } from '../components/LoadingSpinner';

export function VouchPage() {
  const { publicKey, executeSignedTx } = useWalletStore();
  const [loading, setLoading] = useState(true);
  const [vouches, setVouches] = useState<any[]>([]);
  const [voucheePublicKey, setVoucheePublicKey] = useState('');
  const [amount, setAmount] = useState('50');
  const [reason, setReason] = useState('Verified business peer');
  const [durationMonths, setDurationMonths] = useState('6');
  const [error, setError] = useState<string | null>(null);

  const loadVouches = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<{ data: any[] }>(`/vouch/user/${publicKey}`);
      setVouches(res.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load vouches');
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    void loadVouches();
  }, [loadVouches]);

  const handleCreateVouch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey) return;
    setError(null);
    try {
      await executeSignedTx({
        preparePath: '/vouch/prepare-create',
        prepareBody: {
          voucherPublicKey: publicKey,
          voucheePublicKey: voucheePublicKey.trim(),
          amount,
          reason,
          durationMonths: Number(durationMonths),
        },
        submitPath: '/vouch/submit',
        submitBody: {
          action: 'create',
          voucherPublicKey: publicKey,
          voucheePublicKey: voucheePublicKey.trim(),
          amount,
          reason,
        },
      });
      setVoucheePublicKey('');
      await loadVouches();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create vouch');
    }
  };

  const handleVouchAction = async (
    vouchId: number,
    action: 'revoke' | 'expire' | 'withdraw',
    voucheeKey?: string
  ) => {
    if (!publicKey) return;
    setError(null);
    const preparePath =
      action === 'revoke'
        ? `/vouch/${vouchId}/prepare-revoke`
        : action === 'expire'
          ? `/vouch/${vouchId}/prepare-expire`
          : `/vouch/${vouchId}/prepare-withdraw`;

    try {
      await executeSignedTx({
        preparePath,
        prepareBody: { voucherPublicKey: publicKey },
        submitPath: '/vouch/submit',
        submitBody: {
          action,
          vouchId,
          voucherPublicKey: publicKey,
          voucheePublicKey: voucheeKey,
        },
      });
      await loadVouches();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Vouch ${action} failed`);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Escrowed Community Vouching</h1>
        <p className="text-sm text-slate-600">
          Back trusted borrowers with real SEP-41 token escrow. Trust weight is calculated
          deterministically on-chain from your verified score and stake, subject to time decay and a
          50% borrower-default slash cap.
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

      <form
        onSubmit={handleCreateVouch}
        className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2 className="text-base font-semibold text-slate-900">Create Escrowed Vouch</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-slate-600">
              Vouchee Stellar Public Key
            </label>
            <input
              type="text"
              value={voucheePublicKey}
              onChange={(e) => setVoucheePublicKey(e.target.value)}
              placeholder="G..."
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Escrow Stake (XLM)</label>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Duration (1-24 Months)</label>
            <input
              type="number"
              min={1}
              max={24}
              value={durationMonths}
              onChange={(e) => setDurationMonths(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              required
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-slate-600">Reason / Context</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              required
            />
          </div>
        </div>
        <button
          type="submit"
          className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
        >
          Stake &amp; Sign Vouch in Freighter
        </button>
      </form>

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Your Vouches ({vouches.length})</h2>
        {loading ? (
          <div className="flex justify-center py-8">
            <LoadingSpinner />
          </div>
        ) : vouches.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No vouches created yet.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {vouches.map((v) => {
              const id = Number(v.id);
              const vouchee = v.vouchee_key || v.vouchee;
              const isVoucher = (v.voucher_key || v.voucher) === publicKey;
              return (
                <div
                  key={id}
                  className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 p-4 text-sm"
                >
                  <div className="space-y-1">
                    <div className="font-semibold">
                      Vouch #{id} &rarr;{' '}
                      <span className="font-mono text-xs">{String(vouchee).slice(0, 14)}...</span>
                    </div>
                    <div className="text-xs text-slate-600">
                      Stake: {formatStroops(v.amount)} XLM | Escrowed Balance:{' '}
                      {formatStroops(v.escrowed_balance)} XLM | Slashed:{' '}
                      {formatStroops(v.slashed_amount)} XLM | Policy Trust Weight: {v.trust_score}
                    </div>
                    <div className="text-xs text-slate-500">{v.reason}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {isVoucher && v.is_active && (
                      <button
                        type="button"
                        onClick={() => handleVouchAction(id, 'revoke', vouchee)}
                        className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                      >
                        Revoke &amp; Refund
                      </button>
                    )}
                    {v.is_active && (
                      <button
                        type="button"
                        onClick={() => handleVouchAction(id, 'expire', vouchee)}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        Expire
                      </button>
                    )}
                    {isVoucher && !v.is_active && !v.withdrawn && (
                      <button
                        type="button"
                        onClick={() => handleVouchAction(id, 'withdraw', vouchee)}
                        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
                      >
                        Withdraw Remaining
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
