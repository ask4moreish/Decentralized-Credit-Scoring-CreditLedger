import React, { useCallback, useEffect, useState } from 'react';
import { useWalletStore } from '../store/walletStore';
import { apiRequest } from '../services/api';
import { formatStroops } from '../config/stellar';
import { LoadingSpinner } from '../components/LoadingSpinner';

export function LoansPage() {
  const { publicKey, executeSignedTx } = useWalletStore();
  const [loading, setLoading] = useState(true);
  const [loans, setLoans] = useState<any[]>([]);
  const [amount, setAmount] = useState('100');
  const [durationMonths, setDurationMonths] = useState('12');
  const [collateralAmount, setCollateralAmount] = useState('0');
  const [repayInputs, setRepayInputs] = useState<Record<number, string>>({});
  const [eligibility, setEligibility] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const loadLoans = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<{ data: { loans: any[] } }>(`/loans/user/${publicKey}`);
      setLoans(res.data.loans || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch loans');
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    void loadLoans();
  }, [loadLoans]);

  const handleCheckEligibility = async () => {
    if (!publicKey) return;
    setError(null);
    try {
      const res = await apiRequest<{ data: any }>('/loans/check-eligibility', {
        method: 'POST',
        body: JSON.stringify({ userPublicKey: publicKey, amount }),
      });
      setEligibility(res.data);
      if (res.data.requiredCollateralFormatted && Number(collateralAmount) === 0) {
        setCollateralAmount(res.data.requiredCollateralFormatted);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Eligibility check failed');
    }
  };

  const handleApplyLoan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey) return;
    setError(null);
    try {
      await executeSignedTx({
        preparePath: '/loans/prepare-apply',
        prepareBody: {
          borrowerPublicKey: publicKey,
          amount,
          durationMonths: Number(durationMonths),
          collateralAmount,
        },
        submitPath: '/loans/submit',
        submitBody: {
          action: 'apply',
          borrowerPublicKey: publicKey,
          amount,
          durationMonths: Number(durationMonths),
        },
      });
      await loadLoans();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Loan application failed');
    }
  };

  const handleRepay = async (loanId: number) => {
    const repayAmount = repayInputs[loanId] || '10';
    setError(null);
    try {
      await executeSignedTx({
        preparePath: '/loans/prepare-repay',
        prepareBody: { loanId, amount: repayAmount },
        submitPath: '/loans/submit',
        submitBody: { action: 'repay', loanId, borrowerPublicKey: publicKey, amount: repayAmount },
      });
      await loadLoans();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Loan repayment failed');
    }
  };

  const handleCancel = async (loanId: number) => {
    setError(null);
    try {
      await executeSignedTx({
        preparePath: '/loans/prepare-cancel',
        prepareBody: { loanId },
        submitPath: '/loans/submit',
        submitBody: { action: 'cancel', loanId, borrowerPublicKey: publicKey },
      });
      await loadLoans();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Loan cancellation failed');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Borrower Loans &amp; Collateral</h1>
        <p className="text-sm text-slate-600">
          Non-custodial Soroban loan requests with LTV-enforced collateral locking and amortized
          repayments.
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
        onSubmit={handleApplyLoan}
        className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2 className="text-base font-semibold text-slate-900">Apply for a Loan</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <label className="block text-xs font-medium text-slate-600">Loan Amount (XLM)</label>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Duration (Months)</label>
            <input
              type="number"
              min={1}
              max={60}
              value={durationMonths}
              onChange={(e) => setDurationMonths(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">
              Collateral Deposit (XLM, required if score &lt; 60)
            </label>
            <input
              type="text"
              value={collateralAmount}
              onChange={(e) => setCollateralAmount(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleCheckEligibility}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Check Eligibility &amp; LTV Collateral
          </button>
          <button
            type="submit"
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            Prepare &amp; Sign Loan Application
          </button>
        </div>

        {eligibility && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
            <div>
              Eligible: <strong>{eligibility.canBorrow ? 'Yes' : 'No'}</strong> | Verified Score:{' '}
              <strong>{eligibility.creditScore}</strong> | Required Collateral:{' '}
              <strong>{eligibility.requiredCollateralFormatted} XLM</strong>
            </div>
            {eligibility.reasons?.length > 0 && (
              <div className="mt-1 text-rose-700">{eligibility.reasons.join(', ')}</div>
            )}
          </div>
        )}
      </form>

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Your Loans ({loans.length})</h2>
        {loading ? (
          <div className="flex justify-center py-8">
            <LoadingSpinner />
          </div>
        ) : loans.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No loans found for your account.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {loans.map((loan) => {
              const id = Number(loan.id);
              const status = String(loan.status).toLowerCase();
              return (
                <div
                  key={id}
                  className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 p-4"
                >
                  <div className="space-y-1 text-sm">
                    <div className="flex items-center gap-2 font-semibold">
                      <span>Loan #{id}</span>
                      <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs uppercase text-slate-700">
                        {status}
                      </span>
                    </div>
                    <div className="text-xs text-slate-600">
                      Principal: {formatStroops(loan.amount)} XLM | Rate: {loan.interest_rate}% APR |
                      Term: {loan.duration_months} mo
                    </div>
                    <div className="text-xs text-slate-600">
                      Repaid: {formatStroops(loan.repaid_amount)} XLM | Collateral:{' '}
                      {formatStroops(loan.collateral_amount)} XLM (
                      {loan.collateral_locked ? 'Locked' : 'Unlocked'})
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {status === 'pending' && (
                      <button
                        type="button"
                        onClick={() => handleCancel(id)}
                        className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                      >
                        Cancel Pending
                      </button>
                    )}
                    {status === 'active' && (
                      <>
                        <input
                          type="text"
                          value={repayInputs[id] || ''}
                          onChange={(e) =>
                            setRepayInputs((prev) => ({ ...prev, [id]: e.target.value }))
                          }
                          placeholder="Amount XLM"
                          className="w-28 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                        />
                        <button
                          type="button"
                          onClick={() => handleRepay(id)}
                          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
                        >
                          Repay
                        </button>
                      </>
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
