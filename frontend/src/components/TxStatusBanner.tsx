import React from 'react';
import { useWalletStore } from '../store/walletStore';
import { getTxExplorerUrl } from '../config/stellar';

export function TxStatusBanner() {
  const { txState, clearTxState } = useWalletStore();
  if (txState.stage === 'idle') return null;

  const styles: Record<string, string> = {
    preparing: 'border-amber-200 bg-amber-50 text-amber-900',
    awaiting_signature: 'border-indigo-200 bg-indigo-50 text-indigo-900',
    submitting: 'border-blue-200 bg-blue-50 text-blue-900',
    confirmed: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    error: 'border-rose-200 bg-rose-50 text-rose-900',
  };

  return (
    <div
      data-testid="tx-status-banner"
      data-stage={txState.stage}
      role={txState.stage === 'error' ? 'alert' : 'status'}
      className={`mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm ${styles[txState.stage] || 'border-slate-200 bg-slate-50'}`}
    >
      <div>
        <span className="font-semibold capitalize">{txState.stage.replace('_', ' ')}: </span>
        <span>{txState.message}</span>
        {txState.txHash && (
          <span className="ml-2 font-mono text-xs">
            (Tx{' '}
            <a
              href={getTxExplorerUrl(txState.txHash)}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {txState.txHash.slice(0, 12)}...
            </a>
            {txState.ledger ? `, ledger #${txState.ledger}` : ''})
          </span>
        )}
      </div>
      {(txState.stage === 'confirmed' || txState.stage === 'error') && (
        <button
          type="button"
          onClick={clearTxState}
          className="rounded px-2 py-1 text-xs font-medium underline hover:opacity-80"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
