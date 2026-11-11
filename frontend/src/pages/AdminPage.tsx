import React, { useCallback, useEffect, useState } from 'react';
import { useWalletStore } from '../store/walletStore';
import { apiRequest } from '../services/api';
import { formatStroops } from '../config/stellar';
import { LoadingSpinner } from '../components/LoadingSpinner';

export function AdminPage() {
  const { publicKey, isAdmin, roles } = useWalletStore();
  const isIssuer = roles.includes('issuer');

  const [loading, setLoading] = useState(false);
  const [activeLoans, setActiveLoans] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Issuer registry inputs
  const [issuerKey, setIssuerKey] = useState('');
  const [issuerName, setIssuerName] = useState('Regional Utility Provider');
  const [issuerCategory, setIssuerCategory] = useState('1');
  const [issuerUri, setIssuerUri] = useState('https://registry.creditledger.example/issuer.json');

  // Attestation message builder inputs
  const [subjectKey, setSubjectKey] = useState('');
  const [attKind, setAttKind] = useState('1');
  const [attMetric, setAttMetric] = useState('92');
  const [attAmount, setAttAmount] = useState('500');
  const [attMonths, setAttMonths] = useState('12');
  const [builtPayload, setBuiltPayload] = useState<any>(null);

  const loadAdminOverview = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const [loansRes, statsRes] = await Promise.all([
        apiRequest<{ data: { loans: any[] } }>('/loans/admin/active'),
        apiRequest<{ data: any }>('/loans/admin/statistics'),
      ]);
      setActiveLoans(loansRes.data.loans || []);
      setStats(statsRes.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load admin overview');
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadAdminOverview();
  }, [loadAdminOverview]);

  if (!isAdmin && !isIssuer) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        Access restricted: requires Admin or Authorized Issuer role assigned via backend allowlist.
      </div>
    );
  }

  const handleLoanGovernance = async (loanId: number, op: 'approve' | 'default') => {
    setError(null);
    setMessage(null);
    try {
      const res = await apiRequest<{ transactionHash: string; message: string }>(
        `/loans/${loanId}/${op}`,
        {
          method: 'POST',
          idempotencyKey: `admin-${op}-${loanId}-${Date.now()}`,
        }
      );
      setMessage(`${res.message} (Tx: ${res.transactionHash})`);
      await loadAdminOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${op} loan`);
    }
  };

  const handleReconcile = async () => {
    setError(null);
    try {
      const res = await apiRequest<{ data: { reconciled: number; failed: number } }>(
        '/loans/admin/reconcile',
        { method: 'POST' }
      );
      setMessage(
        `Reconciled ${res.data.reconciled} confirmed, ${res.data.failed} failed Stellar transactions.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reconciliation failed');
    }
  };

  const handleRegisterIssuer = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiRequest<{ transactionHash: string }>('/credit-score/issuer/register', {
        method: 'POST',
        body: JSON.stringify({
          issuerPublicKey: issuerKey.trim(),
          category: Number(issuerCategory),
          name: issuerName,
          metadataUri: issuerUri,
        }),
      });
      setMessage(`Issuer registered on-chain (Tx: ${res.transactionHash})`);
      setIssuerKey('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Issuer registration failed');
    }
  };

  const handleBuildAttestationMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiRequest('/credit-score/issuer/build-message', {
        method: 'POST',
        body: JSON.stringify({
          subjectPublicKey: subjectKey.trim(),
          issuerPublicKey: publicKey,
          kind: Number(attKind),
          metricScore: Number(attMetric),
          amount: attAmount,
          durationMonths: Number(attMonths),
          financialData: {
            attestedBy: publicKey,
            metricScore: Number(attMetric),
            amountXlm: attAmount,
          },
        }),
      });
      setBuiltPayload(res);
      setMessage('Domain-separated Soroban attestation payload generated for Ed25519 signing.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to build attestation payload');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Admin &amp; Attestation Issuer Portal</h1>
          <p className="text-sm text-slate-600">
            Role-restricted governance controls, issuer registry, and attestation payload builder.
          </p>
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={handleReconcile}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Run Stellar Tx Reconciliation
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {message}
        </div>
      )}

      {isAdmin && (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">
                Pending &amp; Active Loans Governance ({activeLoans.length})
              </h2>
              {stats && (
                <span className="text-xs text-slate-500">
                  Chain stats: {JSON.stringify(stats)}
                </span>
              )}
            </div>
            {loading ? (
              <div className="flex justify-center py-6">
                <LoadingSpinner />
              </div>
            ) : activeLoans.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">No pending or active loans.</p>
            ) : (
              <div className="mt-4 space-y-3">
                {activeLoans.map((l) => {
                  const id = Number(l.id);
                  const status = String(l.status).toLowerCase();
                  return (
                    <div
                      key={id}
                      className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 p-4 text-sm"
                    >
                      <div>
                        <div className="font-semibold">
                          Loan #{id} ({status})
                        </div>
                        <div className="font-mono text-xs text-slate-600">
                          Borrower: {l.borrower_public_key || l.borrower}
                        </div>
                        <div className="text-xs text-slate-600">
                          Amount: {formatStroops(l.amount)} XLM | Score Used: {l.credit_score_used}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {status === 'pending' && (
                          <button
                            type="button"
                            onClick={() => handleLoanGovernance(id, 'approve')}
                            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
                          >
                            Approve &amp; Disburse
                          </button>
                        )}
                        {status === 'active' && (
                          <button
                            type="button"
                            onClick={() => handleLoanGovernance(id, 'default')}
                            className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-500"
                          >
                            Liquidate Default
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <form
            onSubmit={handleRegisterIssuer}
            className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
          >
            <h2 className="text-base font-semibold text-slate-900">Register Authorized Issuer</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <input
                type="text"
                value={issuerKey}
                onChange={(e) => setIssuerKey(e.target.value)}
                placeholder="Issuer Public Key (G...)"
                className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm sm:col-span-2"
                required
              />
              <input
                type="text"
                value={issuerName}
                onChange={(e) => setIssuerName(e.target.value)}
                placeholder="Institution Name"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                required
              />
              <select
                value={issuerCategory}
                onChange={(e) => setIssuerCategory(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="1">Category 1: Payment / Utility</option>
                <option value="2">Category 2: Savings / Depository</option>
                <option value="3">Category 3: Payroll / Income</option>
                <option value="4">Category 4: Credit Bureau</option>
              </select>
              <input
                type="text"
                value={issuerUri}
                onChange={(e) => setIssuerUri(e.target.value)}
                placeholder="Metadata URI"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm sm:col-span-2"
                required
              />
            </div>
            <button
              type="submit"
              className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              Register Issuer On-Chain
            </button>
          </form>
        </div>
      )}

      <form
        onSubmit={handleBuildAttestationMessage}
        className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2 className="text-base font-semibold text-slate-900">
          Build Signed Attestation Payload (Issuer / Admin)
        </h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <input
            type="text"
            value={subjectKey}
            onChange={(e) => setSubjectKey(e.target.value)}
            placeholder="Subject Stellar Public Key (G...)"
            className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm sm:col-span-2"
            required
          />
          <select
            value={attKind}
            onChange={(e) => setAttKind(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="1">Payment Attestation</option>
            <option value="2">Savings Attestation</option>
          </select>
          <input
            type="number"
            min={0}
            max={100}
            value={attMetric}
            onChange={(e) => setAttMetric(e.target.value)}
            placeholder="Metric Score (0-100)"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            required
          />
          <input
            type="text"
            value={attAmount}
            onChange={(e) => setAttAmount(e.target.value)}
            placeholder="Amount (XLM)"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            required
          />
          <input
            type="number"
            min={1}
            max={120}
            value={attMonths}
            onChange={(e) => setAttMonths(e.target.value)}
            placeholder="Duration Months"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            required
          />
        </div>
        <button
          type="submit"
          className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          Generate Signing Message
        </button>

        {builtPayload && (
          <pre className="mt-4 overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs text-slate-200">
            {JSON.stringify(builtPayload, null, 2)}
          </pre>
        )}
      </form>
    </div>
  );
}
