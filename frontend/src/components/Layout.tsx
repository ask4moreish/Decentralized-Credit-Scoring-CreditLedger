import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useWalletStore } from '../store/walletStore';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/credit-score', label: 'Credit Score' },
  { href: '/loans', label: 'Loans' },
  { href: '/vouch', label: 'Vouch' },
  { href: '/profile', label: 'Profile' },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const { publicKey } = useWalletStore();

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 flex items-center justify-between h-14">
          <Link to="/dashboard" className="font-bold text-indigo-600 text-lg">CreditLedger</Link>
          <div className="flex items-center gap-1">
            {NAV.map(({ href, label }) => (
              <Link
                key={href}
                to={href}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  pathname === href
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                }`}
              >
                {label}
              </Link>
            ))}
          </div>
          <span className="text-xs text-gray-400 font-mono hidden sm:block">
            {publicKey?.slice(0, 8)}…{publicKey?.slice(-4)}
          </span>
        </div>
      </nav>
      <main>{children}</main>
    </div>
  );
}
