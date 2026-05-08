import React from 'react';
import { useWalletStore } from '../store/walletStore';

export function ProfilePage() {
  const { publicKey, network, disconnect } = useWalletStore();

  return (
    <div className="max-w-xl mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Profile</h1>

      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <div>
          <p className="text-xs text-gray-400 mb-1">Public Key</p>
          <p className="font-mono text-sm text-gray-800 break-all">{publicKey}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-1">Network</p>
          <p className="text-sm text-gray-800 capitalize">{network}</p>
        </div>
        <button
          onClick={disconnect}
          className="w-full mt-2 border border-red-300 text-red-600 hover:bg-red-50 font-medium py-2 rounded-lg transition-colors text-sm"
        >
          Disconnect Wallet
        </button>
      </div>
    </div>
  );
}
