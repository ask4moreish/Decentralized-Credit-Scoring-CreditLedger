import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWalletStore } from '../store/walletStore';
import { apiRequest } from '../services/api';
import { formatStroops } from '../config/stellar';
import { LoadingSpinner } from '../components/LoadingSpinner';

export function DashboardPage() {
  const { publicKey, role } = useWalletStore();
  const [loading, setLoading] = useState(true);
  const [breakdown, setBreakdown] = useState<any>(null);
  const [loans, setLoans] = useState<any[]>([]);
  const [vouches, setVouches] = useState<any[]>([]);
  const [pool, setPool] = useState<any>(null);

  useEffect(() => {
    if (!publicKey) return;
    let active = true;
    (async () => {
      setLoading(true);
      try {
        const [bdRes, loanRes, vouchRes, poolRes] = await Promise.allSettled([
          apiRequest<{ data: any }>(`/credit-score/${publicKey}/breakdown`),
          apiRequest<{ data: { loans: any[] } }>(`/loans/user/${publicKey}`),
          apiRequest<{ data: any[] }>(`/vouch/user/${publicKey}`),
          apiRequest<{ data: any }>('/loans/pool'),
        ]);
        if (!active) return;
        if (bdRes.status === 'fulfilled') setBreakdown(bdRes.value.data);
        if (loanRes.status === 'fulfilled') setLoans(loanRes.value.data.loans || []);
        if (vouchRes.status === 'fulfilled') setVouches(vouchRes.value.data || []);
        if (poolRes.status === 'fulfilled') setPool(poolRes.value.data);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [publicKey]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const score = breakdown?.overallScore ?? 0;
  const activeLoansCount = loans.filter((l) => String(l.status).toLowerCase() === 'active').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Portfolio &amp; Protocol Dashboard</h1>
          <p className="text-sm text-slate-600">
            Session mode: <span className="font-semibold capitalize">{role}</span>
          </p>
        </div>
        <div className="flex gap-3">
          <Link
            to="/loans"
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Borrow / Repay
          </Link>
          <Link
            to="/lender"
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Lender Pool
          </Link>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase text-slate-500">Verified Credit Score</div>
          <div className="mt-2 text-3xl font-bold text-indigo-700">{score} / 100</div>
          <div className="mt-1 text-xs text-slate-500">Model v{breakdown?.modelVersion ?? 2}</div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase text-slate-500">Your Loans</div>
          <div className="mt-2 text-3xl font-bold text-slate-900">{loans.length}</div>
          <div className="mt-1 text-xs text-slate-500">{activeLoansCount} active</div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase text-slate-500">Pool Available Liquidity</div>
          <div className="mt-2 text-3xl font-bold text-emerald-700">
            {pool?.availableCash ?? '0'} XLM
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Locked collateral: {formatStroops(pool?.totalCollateralLockedStroops)} XLM
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium uppercase text-slate-500">Community Vouches</div>
          <div className="mt-2 text-3xl font-bold text-slate-900">{vouches.length}</div>
          <div className="mt-1 text-xs text-slate-500">Escrowed trust relationships</div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">Verified Score Pillars</h2>
            <Link to="/credit-score" className="text-xs font-semibold text-indigo-600 hover:underline">
              Full Breakdown &amp; Privacy
            </Link>
          </div>
          <div className="mt-4 space-y-3 text-sm">
            {[
              ['Payment History (35%)', breakdown?.pillars?.paymentHistory?.score ?? 0],
              ['Savings Attestations (25%)', breakdown?.pillars?.savings?.score ?? 0],
              ['Loan Repayment (20%)', breakdown?.pillars?.repayment?.score ?? 0],
              ['Community Vouching (10%)', breakdown?.pillars?.community?.score ?? 0],
              ['Activity & Tenure (10%)', breakdown?.pillars?.activity?.score ?? 0],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <div className="flex justify-between text-xs font-medium text-slate-600">
                  <span>{label}</span>
                  <span>{value} / 100</span>
                </div>
                <div className="mt-1 h-2 w-full rounded-full bg-slate-100">
                  <div
                    className="h-2 rounded-full bg-indigo-600"
                    style={{ width: `${Math.min(100, Number(value))}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Quick Actions</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Link
              to="/loans"
              className="rounded-lg border border-slate-200 p-4 hover:border-indigo-300 hover:bg-indigo-50/40"
            >
              <div className="font-semibold text-slate-900">Check Loan Eligibility</div>
              <p className="mt-1 text-xs text-slate-600">
                Calculate APR tier &amp; LTV collateral before signing.
              </p>
            </Link>
            <Link
              to="/lender"
              className="rounded-lg border border-slate-200 p-4 hover:border-indigo-300 hover:bg-indigo-50/40"
            >
              <div className="font-semibold text-slate-900">Supply Liquidity</div>
              <p className="mt-1 text-xs text-slate-600">
                Deposit SEP-41 tokens &amp; earn amortized loan interest.
              </p>
            </Link>
            <Link
              to="/vouch"
              className="rounded-lg border border-slate-200 p-4 hover:border-indigo-300 hover:bg-indigo-50/40"
            >
              <div className="font-semibold text-slate-900">Escrow a Community Vouch</div>
              <p className="mt-1 text-xs text-slate-600">
                Back trusted borrowers with revocable staked escrow.
              </p>
            </Link>
            <Link
              to="/credit-score"
              className="rounded-lg border border-slate-200 p-4 hover:border-indigo-300 hover:bg-indigo-50/40"
            >
              <div className="font-semibold text-slate-900">Privacy &amp; Selective Consent</div>
              <p className="mt-1 text-xs text-slate-600">
                Manage encrypted evidence grants &amp; data erasure.
              </p>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
