import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWalletStore } from '../store/walletStore';
import { API_URL } from '../config/stellar';
import { Button } from '../components/Button';

async function fetchLoans(publicKey: string, token?: string | null) {
  const headers: HeadersInit = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_URL}/api/loans/user/${publicKey}`, { headers });
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
  const { publicKey, getAuthToken, signTransaction } = useWalletStore();
  const token = getAuthToken();

  const [amount, setAmount] = useState('');
  const [durationMonths, setDurationMonths] = useState('12');
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [applySuccess, setApplySuccess] = useState('');

  const [repayLoanId, setRepayLoanId] = useState<number | null>(null);
  const [repayAmount, setRepayAmount] = useState('');
  const [isRepaying, setIsRepaying] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['loans', publicKey],
    queryFn: () => fetchLoans(publicKey!, token),
    enabled: !!publicKey,
  });

  const loans: any[] = data?.data?.loans ?? [];

  async function handleApply(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey) return;

    setIsApplying(true);
    setApplyError('');
    setApplySuccess('');

    try {
      // 1. Prepare unsigned transaction from backend
      const prepRes = await fetch(`${API_URL}/api/loans/prepare-apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          borrowerPublicKey: publicKey,
          amount: parseFloat(amount),
          durationMonths: parseInt(durationMonths),
        }),
      });

      if (!prepRes.ok) {
        const errJson = await prepRes.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to prepare loan application');
      }

      const { xdr } = await prepRes.json();

      // 2. Sign transaction with Freighter wallet
      let signedXdr = xdr;
      try {
        signedXdr = await signTransaction(xdr);
      } catch (signErr: any) {
        throw new Error(`Freighter signature rejected: ${signErr.message || signErr}`);
      }

      // 3. Submit signed transaction
      const submitRes = await fetch(`${API_URL}/api/loans/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          signedXDR: signedXdr,
          borrowerPublicKey: publicKey,
          amount: parseFloat(amount),
          durationMonths: parseInt(durationMonths),
          action: 'apply',
        }),
      });

      if (!submitRes.ok) {
        const submitErr = await submitRes.json().catch(() => ({}));
        throw new Error(submitErr.error || 'Failed to submit loan transaction');
      }

      setApplySuccess('Loan application successfully created and submitted!');
      setAmount('');
      refetch();
    } catch (err: any) {
      setApplyError(err.message || 'Error creating loan application');
    } finally {
      setIsApplying(false);
    }
  }

  async function handleRepay(loanId: number) {
    if (!publicKey || !repayAmount) return;

    setIsRepaying(true);
    try {
      const prepRes = await fetch(`${API_URL}/api/loans/prepare-repay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          loanId,
          amount: parseFloat(repayAmount),
        }),
      });

      if (!prepRes.ok) {
        const errJson = await prepRes.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to prepare repayment');
      }

      const { xdr } = await prepRes.json();
      const signedXdr = await signTransaction(xdr);

      await fetch(`${API_URL}/api/loans/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          signedXDR: signedXdr,
          loanId,
          amount: parseFloat(repayAmount),
          action: 'repay',
        }),
      });

      setRepayLoanId(null);
      setRepayAmount('');
      refetch();
    } catch (err: any) {
      alert(`Repayment failed: ${err.message || err}`);
    } finally {
      setIsRepaying(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Decentralized Loans</h1>
      <p className="text-sm text-gray-500 mb-6">
        Borrow against your on-chain credit reputation with non-custodial Freighter transaction authorization.
      </p>

      {/* Loan Application Form */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-8 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Apply for a Loan</h2>
        {applyError && <p className="text-red-500 text-sm mb-3 bg-red-50 p-2 rounded">{applyError}</p>}
        {applySuccess && <p className="text-green-600 text-sm mb-3 bg-green-50 p-2 rounded">{applySuccess}</p>}

        <form onSubmit={handleApply} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Loan Amount (XLM)</label>
              <input
                type="number"
                step="any"
                min="1"
                placeholder="e.g. 500"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Duration (Months)</label>
              <select
                value={durationMonths}
                onChange={(e) => setDurationMonths(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="3">3 Months</option>
                <option value="6">6 Months</option>
                <option value="12">12 Months</option>
                <option value="24">24 Months</option>
              </select>
            </div>
          </div>

          <Button type="submit" isLoading={isApplying} disabled={isApplying} className="w-full">
            {isApplying ? 'Sign in Freighter…' : 'Submit Loan Application'}
          </Button>
        </form>
      </div>

      <h2 className="text-lg font-semibold text-gray-900 mb-4">Your Loan Portfolio</h2>

      {isLoading && <p className="text-gray-500">Loading loans…</p>}
      {Boolean(error) && <p className="text-red-500">Failed to load loans.</p>}

      {!isLoading && loans.length === 0 && (
        <div className="bg-gray-50 rounded-xl border border-dashed border-gray-200 p-8 text-center text-gray-500 text-sm">
          No loan records found for this account.
        </div>
      )}

      <div className="space-y-4">
        {loans.map((loan) => (
          <div key={loan.id} className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <span className="font-semibold text-gray-900">Loan #{loan.id}</span>
              <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${STATUS_COLORS[loan.status] ?? 'bg-gray-100 text-gray-700'}`}>
                {loan.status}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2 text-sm text-gray-600 mb-4">
              <div>
                <span className="text-xs text-gray-400">Principal</span>
                <br />
                <span className="font-semibold">{loan.amount}</span>
              </div>
              <div>
                <span className="text-xs text-gray-400">Interest Rate</span>
                <br />
                <span className="font-semibold">{loan.interest_rate || loan.interestRate || 10}%</span>
              </div>
              <div>
                <span className="text-xs text-gray-400">Duration</span>
                <br />
                <span className="font-semibold">{loan.duration_months || loan.durationMonths}mo</span>
              </div>
              <div>
                <span className="text-xs text-gray-400">Repaid</span>
                <br />
                <span className="font-semibold">{loan.repaid_amount || loan.repaidAmount || 0}</span>
              </div>
            </div>

            {loan.status === 'active' && (
              <div className="border-t pt-3 mt-3">
                {repayLoanId === loan.id ? (
                  <div className="flex gap-2">
                    <input
                      type="number"
                      placeholder="Amount to repay"
                      value={repayAmount}
                      onChange={(e) => setRepayAmount(e.target.value)}
                      className="border border-gray-300 rounded px-2 py-1 text-sm flex-1"
                    />
                    <Button size="sm" isLoading={isRepaying} onClick={() => handleRepay(loan.id)}>
                      Confirm
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRepayLoanId(null)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setRepayLoanId(loan.id)}>
                    Make Repayment
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
