import React, { useEffect, useState } from 'react';
import { useWalletStore } from '../store/walletStore';
import { apiRequest } from '../services/api';
import { STELLAR_CONFIG } from '../config/stellar';

export function ProfilePage() {
  const { publicKey, balance, role, roles, isAdmin, network, disconnect } = useWalletStore();
  const [summary, setSummary] = useState<any>(null);

  useEffect(() => {
    if (!publicKey) return;
    void apiRequest<{ data: any }>(`/users/${publicKey}/summary`)
      .then((res) => setSummary(res.data))
      .catch(() => undefined);
  }, [publicKey]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">Wallet &amp; Session Profile</h1>

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase text-slate-500">Stellar Public Key</dt>
            <dd className="mt-1 break-all font-mono text-slate-900">{publicKey}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-slate-500">Horizon Native Balance</dt>
            <dd className="mt-1 font-semibold text-slate-900">{balance || '0.00'} XLM</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-slate-500">Assigned Roles</dt>
            <dd className="mt-1 font-medium capitalize text-indigo-700">
              {roles.join(', ')} (Active: {role}, Admin: {isAdmin ? 'Yes' : 'No'})
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-slate-500">Soroban Network</dt>
            <dd className="mt-1 uppercase text-slate-900">{network}</dd>
          </div>
        </dl>

        {summary && (
          <div className="mt-6 rounded-lg bg-slate-50 p-4 text-xs text-slate-700">
            Account Summary: Score {summary.creditScore?.score ?? 0} / 100 |{' '}
            {summary.loans?.length ?? 0} Loans | {summary.vouches?.length ?? 0} Vouches
          </div>
        )}

        <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-xs text-slate-600">
          <div>CreditScore Contract: {STELLAR_CONFIG.contracts.creditScore}</div>
          <div>LoanManager Contract: {STELLAR_CONFIG.contracts.loanManager}</div>
          <div>CommunityVouch Contract: {STELLAR_CONFIG.contracts.communityVouch}</div>
        </div>

        <button
          type="button"
          onClick={() => void disconnect()}
          className="mt-6 rounded-lg border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50"
        >
          Revoke Session &amp; Disconnect
        </button>
      </div>
    </div>
  );
}
