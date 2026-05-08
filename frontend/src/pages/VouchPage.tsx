import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWalletStore } from '../store/walletStore';
import { API_URL } from '../config/stellar';

async function fetchVouches(publicKey: string, token: string) {
  const res = await fetch(`${API_URL}/api/vouch/user/${publicKey}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Failed to fetch vouches');
  return res.json();
}

export function VouchPage() {
  const { publicKey } = useWalletStore();
  const token = localStorage.getItem('auth_token') ?? '';
  const [form, setForm] = useState({ voucheePublicKey: '', amount: '', trustScore: '50', reason: '', durationMonths: '12' });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['vouches', publicKey],
    queryFn: () => fetchVouches(publicKey!, token),
    enabled: !!publicKey,
  });

  const vouches: any[] = data?.data ?? [];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await fetch(`${API_URL}/api/vouch/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ voucherPublicKey: publicKey, ...form, amount: Number(form.amount), trustScore: Number(form.trustScore), durationMonths: Number(form.durationMonths) }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setForm({ voucheePublicKey: '', amount: '', trustScore: '50', reason: '', durationMonths: '12' });
      refetch();
    } catch (err: any) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Community Vouching</h1>

      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Create a Vouch</h2>
        {submitError && <p className="text-red-500 text-sm mb-3">{submitError}</p>}
        <form onSubmit={handleSubmit} className="space-y-3">
          {[
            { name: 'voucheePublicKey', label: 'Vouchee Public Key', type: 'text' },
            { name: 'amount', label: 'Amount', type: 'number' },
            { name: 'trustScore', label: 'Trust Score (0–100)', type: 'number' },
            { name: 'reason', label: 'Reason', type: 'text' },
            { name: 'durationMonths', label: 'Duration (months)', type: 'number' },
          ].map(({ name, label, type }) => (
            <div key={name}>
              <label className="block text-sm text-gray-600 mb-1">{label}</label>
              <input
                type={type}
                value={(form as any)[name]}
                onChange={(e) => setForm((f) => ({ ...f, [name]: e.target.value }))}
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          ))}
          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-medium py-2 rounded-lg transition-colors"
          >
            {submitting ? 'Submitting…' : 'Create Vouch'}
          </button>
        </form>
      </div>

      <h2 className="text-lg font-semibold text-gray-900 mb-3">Your Vouches</h2>
      {isLoading && <p className="text-gray-500">Loading…</p>}
      {!isLoading && vouches.length === 0 && <p className="text-gray-500">No vouches yet.</p>}
      <div className="space-y-3">
        {vouches.map((v: any) => (
          <div key={v.id} className="bg-white rounded-xl border border-gray-200 p-4 text-sm">
            <p className="font-mono text-xs text-gray-500 truncate mb-1">{v.vouchee}</p>
            <div className="flex gap-4 text-gray-700">
              <span>Amount: {v.amount}</span>
              <span>Trust: {v.trust_score}</span>
              <span className={v.is_active ? 'text-green-600' : 'text-gray-400'}>{v.is_active ? 'Active' : 'Inactive'}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
