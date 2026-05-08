import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWalletStore } from '../store/walletStore';
import { API_URL } from '../config/stellar';

async function fetchCreditScore(publicKey: string) {
  const res = await fetch(`${API_URL}/api/credit-score/${publicKey}`);
  if (!res.ok) throw new Error('Failed to fetch credit score');
  return res.json();
}

function scoreLabel(score: number) {
  if (score >= 800) return { label: 'Excellent', color: 'text-green-600' };
  if (score >= 700) return { label: 'Good', color: 'text-blue-600' };
  if (score >= 600) return { label: 'Fair', color: 'text-yellow-600' };
  if (score >= 500) return { label: 'Poor', color: 'text-orange-600' };
  return { label: 'Very Poor', color: 'text-red-600' };
}

export function CreditScorePage() {
  const { publicKey } = useWalletStore();
  const { data, isLoading, error } = useQuery({
    queryKey: ['credit-score', publicKey],
    queryFn: () => fetchCreditScore(publicKey!),
    enabled: !!publicKey,
  });

  const score = data?.data?.score ?? 0;
  const { label, color } = scoreLabel(score);

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Credit Score</h1>

      {isLoading && <p className="text-gray-500">Loading…</p>}
      {error && <p className="text-red-500">Failed to load credit score.</p>}

      {data && (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
          <p className={`text-6xl font-bold mb-2 ${color}`}>{score}</p>
          <p className={`text-lg font-medium ${color}`}>{label}</p>

          <div className="mt-8 grid grid-cols-2 gap-4 text-left">
            {[
              { label: 'Payment History', value: data.data?.payment_history_score },
              { label: 'Savings', value: data.data?.savings_score },
              { label: 'Community', value: data.data?.community_score },
              { label: 'Activity', value: data.data?.activity_score },
            ].map((item) => (
              <div key={item.label} className="bg-gray-50 rounded-lg p-4">
                <p className="text-xs text-gray-500 mb-1">{item.label}</p>
                <p className="text-xl font-semibold text-gray-900">{item.value ?? 0}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
