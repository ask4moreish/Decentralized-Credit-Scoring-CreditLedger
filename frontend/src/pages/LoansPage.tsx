import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWalletStore } from '../store/walletStore';
import { API_URL } from '../config/stellar';

async function fetchLoans(publicKey: string, token: string) {
  const res = await fetch(`${API_URL}/api/loans/user/${publicKey}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Failed to fetch loans');
  return res.json();
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  active: 'bg-blue-100 text-blue-800',
  repaid: 'bg-green-100 text-green-800',
  defaulted: 'bg-red-100 text-red-800',
};

export function LoansPage() {
  const { publicKey } = useWalletStore();
  const token = localStorage.getItem('auth_token') ?? '';

  const { data, isLoading, error } = useQuery({
    queryKey: ['loans', publicKey],
    queryFn: () => fetchLoans(publicKey!, token),
    enabled: !!publicKey,
  });

  const loans: any[] = data?.data?.loans ?? [];

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Loans</h1>

      {isLoading && <p className="text-gray-500">Loading…</p>}
      {error && <p className="text-red-500">Failed to load loans.</p>}

      {!isLoading && loans.length === 0 && (
        <p className="text-gray-500">No loans found.</p>
      )}

      <div className="space-y-4">
        {loans.map((loan) => (
          <div key={loan.id} className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-gray-900">Loan #{loan.id}</span>
              <span className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_COLORS[loan.status] ?? 'bg-gray-100 text-gray-700'}`}>
                {loan.status}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-sm text-gray-600">
              <div><span className="text-gray-400">Amount</span><br />{loan.amount}</div>
              <div><span className="text-gray-400">Rate</span><br />{loan.interest_rate}%</div>
              <div><span className="text-gray-400">Duration</span><br />{loan.duration_months}mo</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
