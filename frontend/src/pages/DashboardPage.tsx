import React from 'react';
import { Link } from 'react-router-dom';
import { useWalletStore } from '../store/walletStore';

export function DashboardPage() {
  const { publicKey } = useWalletStore();

  const cards = [
    { label: 'Credit Score', href: '/credit-score', description: 'View your on-chain credit score' },
    { label: 'Loans', href: '/loans', description: 'Apply for or manage your loans' },
    { label: 'Vouch', href: '/vouch', description: 'Give or receive community vouches' },
    { label: 'Profile', href: '/profile', description: 'Manage your account' },
  ];

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Dashboard</h1>
      <p className="text-sm text-gray-500 mb-8 font-mono truncate">{publicKey}</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {cards.map((card) => (
          <Link
            key={card.href}
            to={card.href}
            className="block bg-white rounded-xl border border-gray-200 p-6 hover:shadow-md transition-shadow"
          >
            <h2 className="text-lg font-semibold text-gray-900 mb-1">{card.label}</h2>
            <p className="text-sm text-gray-500">{card.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
