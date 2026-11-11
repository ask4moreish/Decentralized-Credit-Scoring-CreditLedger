import React, { useCallback, useEffect, useState } from 'react';
import { useWalletStore } from '../store/walletStore';
import { apiRequest } from '../services/api';
import { LoadingSpinner } from '../components/LoadingSpinner';

export function CreditScorePage() {
  const { publicKey, executeSignedTx } = useWalletStore();
  const [loading, setLoading] = useState(true);
  const [breakdown, setBreakdown] = useState<any>(null);
  const [trends, setTrends] = useState<any>(null);
  const [records, setRecords] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // Supplementary 0-weight record form
  const [suppKind, setSuppKind] = useState<number>(1);
  const [suppAmount, setSuppAmount] = useState('250');
  const [suppMetric, setSuppMetric] = useState('90');
  const [suppMonths, setSuppMonths] = useState('6');
  const [suppNotes, setSuppNotes] = useState('');

  // Consent grant form
  const [granteeKey, setGranteeKey] = useState('');
  const [grantScope, setGrantScope] = useState('monthlyIncome,onTimeMonths');
  const [createdGrantId, setCreatedGrantId] = useState<string | null>(null);
  const [confirmErase, setConfirmErase] = useState(false);

  const loadData = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    setError(null);
    try {
      const [bdRes, trRes, recRes] = await Promise.all([
        apiRequest<{ data: any }>(`/credit-score/${publicKey}/breakdown`),
        apiRequest<{ data: any }>(`/credit-score/${publicKey}/trends`),
        apiRequest<{ data: { records: any[] } }>(`/credit-score/${publicKey}/records`),
      ]);
      setBreakdown(bdRes.data);
      setTrends(trRes.data);
      setRecords(recRes.data.records || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load credit score details');
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleSupplementarySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey) return;
    setError(null);
    setActionMsg(null);
    try {
      await executeSignedTx({
        preparePath: '/credit-score/prepare-supplementary',
        prepareBody: {
          userPublicKey: publicKey,
          kind: suppKind,
          amount: suppAmount,
          claimedMetric: Number(suppMetric),
          durationMonths: Number(suppMonths),
          recordPayload: { note: suppNotes || 'Self-reported supplementary anchor' },
        },
        submitPath: '/credit-score/submit-transaction',
        submitBody: { userPublicKey: publicKey },
      });
      setActionMsg('Supplementary commitment anchored on-chain (0% authoritative weight).');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit supplementary anchor');
    }
  };

  const handleGrantConsent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey) return;
    setError(null);
    setActionMsg(null);
    try {
      const scope = grantScope
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const recordIds = records.map((r) => r.id);
      const res = await apiRequest<{ grantId: string }>(`/credit-score/${publicKey}/consent`, {
        method: 'POST',
        body: JSON.stringify({ granteePublicKey: granteeKey.trim(), scope, recordIds }),
      });
      setCreatedGrantId(res.grantId);
      setActionMsg(`Selective disclosure consent created: ${res.grantId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to grant consent');
    }
  };

  const handleRevokeGrant = async () => {
    if (!publicKey || !createdGrantId) return;
    setError(null);
    try {
      await apiRequest(`/credit-score/${publicKey}/consent/${createdGrantId}/revoke`, {
        method: 'POST',
      });
      setActionMsg(`Consent grant ${createdGrantId} revoked.`);
      setCreatedGrantId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke consent');
    }
  };

  const handleErasePrivacy = async () => {
    if (!publicKey) return;
    setError(null);
    try {
      const res = await apiRequest<{ deletedRecords: number }>(`/credit-score/${publicKey}/privacy`, {
        method: 'DELETE',
      });
      setConfirmErase(false);
      setActionMsg(`Erased ${res.deletedRecords} off-chain encrypted record(s).`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to erase private records');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Verifiable Credit Score &amp; Privacy</h1>
          <p className="text-sm text-slate-600">
            Authoritative on-chain Model v{breakdown?.modelVersion ?? 2} breakdown &amp; encrypted
            off-chain evidence controls
          </p>
        </div>
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-5 py-3 text-center">
          <div className="text-xs font-medium uppercase text-indigo-600">Overall Score</div>
          <div className="text-3xl font-extrabold text-indigo-800">
            {breakdown?.overallScore ?? 0} / 100
          </div>
          {Number(breakdown?.defaultPenalty ?? 0) > 0 && (
            <div className="text-xs text-rose-700">
              Default penalty applied: -{breakdown.defaultPenalty}
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </div>
      )}
      {actionMsg && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {actionMsg}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-5">
        {(
          [
            ['Payment History', breakdown?.pillars?.paymentHistory],
            ['Savings Reserves', breakdown?.pillars?.savings],
            ['Loan Repayment', breakdown?.pillars?.repayment],
            ['Community Vouch', breakdown?.pillars?.community],
            ['Activity / Tenure', breakdown?.pillars?.activity],
          ] as Array<[string, any]>
        ).map(([title, pillar]) => (
          <div key={title} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs font-medium text-slate-500">{title}</div>
            <div className="mt-1 text-2xl font-bold text-slate-900">{pillar?.score ?? 0}</div>
            <div className="mt-1 text-xs text-slate-500">Weight: {pillar?.weightPct ?? 0}%</div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">
            Recorded Historical Score Snapshots
          </h2>
          {trends?.snapshots?.length ? (
            <div className="mt-3 space-y-2 text-sm">
              <div className="text-xs text-slate-500">
                Change since prior snapshot: {trends.change >= 0 ? `+${trends.change}` : trends.change}
              </div>
              <ul className="divide-y divide-slate-100">
                {trends.snapshots.slice(-8).map((s: any, idx: number) => (
                  <li key={`${s.date}-${idx}`} className="flex justify-between py-2">
                    <span className="text-xs text-slate-600">
                      {new Date(s.date).toLocaleString()}
                    </span>
                    <span className="font-semibold text-indigo-700">{s.score}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="mt-2 text-sm text-slate-500">
              No on-chain score snapshots recorded yet. Verified issuer attestations or loan
              outcomes populate genuine snapshots.
            </p>
          )}
        </div>

        <form
          onSubmit={handleSupplementarySubmit}
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <h2 className="text-base font-semibold text-slate-900">
            Anchor Supplementary Evidence (0% Score Weight)
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            Self-reported metadata is encrypted with AES-256-GCM and hash-anchored on-chain for
            manual review only. It does NOT raise your authoritative score.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <select
              value={suppKind}
              onChange={(e) => setSuppKind(Number(e.target.value))}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value={1}>Payment Proof</option>
              <option value={2}>Savings Proof</option>
            </select>
            <input
              type="text"
              value={suppAmount}
              onChange={(e) => setSuppAmount(e.target.value)}
              placeholder="Claimed Amount (XLM)"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              required
            />
            <input
              type="number"
              min={0}
              max={100}
              value={suppMetric}
              onChange={(e) => setSuppMetric(e.target.value)}
              placeholder="Claimed Metric (0-100)"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              required
            />
            <input
              type="number"
              min={1}
              max={120}
              value={suppMonths}
              onChange={(e) => setSuppMonths(e.target.value)}
              placeholder="Duration Months"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              required
            />
          </div>
          <input
            type="text"
            value={suppNotes}
            onChange={(e) => setSuppNotes(e.target.value)}
            placeholder="Optional context (stored encrypted off-chain)"
            className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="mt-4 rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
          >
            Prepare &amp; Sign Commitment Anchor
          </button>
        </form>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">
              Encrypted Off-Chain Records ({records.length})
            </h2>
            {!confirmErase ? (
              <button
                type="button"
                onClick={() => setConfirmErase(true)}
                className="text-xs font-semibold text-rose-600 hover:underline"
              >
                Erase Off-Chain Private Data
              </button>
            ) : (
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={handleErasePrivacy}
                  className="rounded bg-rose-600 px-2 py-1 font-semibold text-white"
                >
                  Confirm Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmErase(false)}
                  className="text-slate-600 underline"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          {records.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No encrypted off-chain records stored.</p>
          ) : (
            <div className="mt-3 space-y-2 text-xs">
              {records.map((r) => (
                <div key={r.id} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                  <div className="flex justify-between font-semibold">
                    <span className="capitalize">{r.recordKind}</span>
                    <span className={r.verified ? 'text-emerald-700' : 'text-amber-700'}>
                      {r.verified ? 'Issuer Attested' : 'Self-Reported (0% Weight)'}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-slate-500">
                    Commitment: {String(r.recordCommitment).slice(0, 18)}...
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <form
          onSubmit={handleGrantConsent}
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <h2 className="text-base font-semibold text-slate-900">
            Selective Disclosure Consent Control
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            Share specific claim keys without exposing sensitive identifiers (SSN, IBAN, account
            numbers are blocked automatically).
          </p>
          <input
            type="text"
            value={granteeKey}
            onChange={(e) => setGranteeKey(e.target.value)}
            placeholder="Grantee Stellar Public Key (G...)"
            className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
            required
          />
          <input
            type="text"
            value={grantScope}
            onChange={(e) => setGrantScope(e.target.value)}
            placeholder="Allowed fields comma-separated"
            className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            required
          />
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="submit"
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              Grant Selective Consent
            </button>
            {createdGrantId && (
              <button
                type="button"
                onClick={handleRevokeGrant}
                className="rounded-lg border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50"
              >
                Revoke Latest Grant
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
