import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWalletStore } from '../store/walletStore';

export function LoginPage() {
  const { isConnected, isLoading, error, connect, clearError } = useWalletStore();
  const [preferredRole, setPreferredRole] = useState<'borrower' | 'lender'>('borrower');
  const navigate = useNavigate();

  useEffect(() => {
    if (isConnected) {
      navigate('/dashboard');
    }
  }, [isConnected, navigate]);

  const handleConnect = async () => {
    clearError();
    try {
      await connect(preferredRole);
    } catch {
      // Error surfaced cleanly via Zustand store
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-bold text-slate-900">Connect Stellar Wallet</h1>
        <p className="mt-2 text-sm text-slate-600">
          Authenticate via Freighter Ed25519 challenge signature. Private keys never leave your
          wallet extension.
        </p>

        <div className="mt-6">
          <label className="block text-sm font-medium text-slate-700">Primary Session View</label>
          <div className="mt-2 grid grid-cols-2 gap-3">
            {(['borrower', 'lender'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setPreferredRole(mode)}
                className={`rounded-lg border px-4 py-2 text-sm font-medium capitalize transition ${
                  preferredRole === mode
                    ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                    : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
          >
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={handleConnect}
          disabled={isLoading}
          className="mt-6 w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          {isLoading ? 'Verifying Signature...' : 'Connect & Sign with Freighter'}
        </button>

        <p className="mt-4 text-center text-xs text-slate-500">
          Admin &amp; Issuer permissions are assigned solely by server-verified Stellar public key
          allowlists.
        </p>
      </div>
    </div>
  );
}
