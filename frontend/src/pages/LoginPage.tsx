import React from 'react';
import { Navigate } from 'react-router-dom';
import { useWalletStore } from '../store/walletStore';

export function LoginPage() {
  const { isConnected, isConnecting, connect, error } = useWalletStore();

  if (isConnected) return <Navigate to="/dashboard" replace />;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white p-8 rounded-xl shadow-md w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">CreditLedger</h1>
        <p className="text-gray-500 mb-6">Connect your Stellar wallet to continue</p>

        {error && (
          <p className="text-red-500 text-sm mb-4">{error}</p>
        )}

        <button
          onClick={connect}
          disabled={isConnecting}
          className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-medium py-2.5 px-4 rounded-lg transition-colors"
        >
          {isConnecting ? 'Connecting…' : 'Connect Freighter Wallet'}
        </button>

        <p className="text-xs text-gray-400 mt-4">
          Requires the{' '}
          <a href="https://freighter.app" target="_blank" rel="noreferrer" className="underline">
            Freighter
          </a>{' '}
          browser extension
        </p>
      </div>
    </div>
  );
}
