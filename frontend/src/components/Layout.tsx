import React from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useWalletStore } from '../store/walletStore';
import { TxStatusBanner } from './TxStatusBanner';

export function Layout({ children }: { children: React.ReactNode }) {
  const { publicKey, balance, role, roles, isAdmin, network, disconnect } = useWalletStore();
  const navigate = useNavigate();

  const canAccessAdmin = isAdmin || roles.includes('issuer');

  const navLinks = [
    { to: '/dashboard', label: 'Dashboard' },
    { to: '/credit-score', label: 'Credit Score' },
    { to: '/loans', label: 'Loans' },
    { to: '/lender', label: 'Lender Pool' },
    { to: '/vouch', label: 'Vouch' },
    ...(canAccessAdmin ? [{ to: '/admin', label: 'Admin / Issuer' }] : []),
    { to: '/profile', label: 'Profile' },
  ];

  const handleDisconnect = async () => {
    await disconnect();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-xl font-bold tracking-tight text-indigo-700">
              CreditLedger
            </Link>
            <nav className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {navLinks.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `rounded-md px-3 py-1.5 transition ${
                      isActive
                        ? 'bg-indigo-50 text-indigo-700'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3 text-xs">
            <span className="rounded-full bg-slate-100 px-2.5 py-1 font-medium uppercase text-slate-700">
              {network}
            </span>
            <span className="rounded-full bg-indigo-50 px-2.5 py-1 font-semibold capitalize text-indigo-700">
              {role}
            </span>
            {publicKey && (
              <span className="font-mono text-slate-600" title={publicKey}>
                {publicKey.slice(0, 6)}...{publicKey.slice(-4)}
                {balance ? ` (${balance} XLM)` : ''}
              </span>
            )}
            <button
              type="button"
              onClick={handleDisconnect}
              className="rounded-md border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100"
            >
              Disconnect
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <TxStatusBanner />
        {children}
      </main>
    </div>
  );
}
