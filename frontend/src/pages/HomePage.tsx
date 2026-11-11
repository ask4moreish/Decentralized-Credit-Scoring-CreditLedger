import React from 'react';
import { Link } from 'react-router-dom';
import { useWalletStore } from '../store/walletStore';

export function HomePage() {
  const { isConnected } = useWalletStore();

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-indigo-950 to-slate-900 text-white">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="flex items-center justify-between">
          <span className="text-2xl font-bold tracking-tight text-indigo-300">CreditLedger</span>
          <div className="flex items-center gap-4 text-sm">
            <Link to="/about" className="text-slate-300 hover:text-white">
              Protocol Architecture
            </Link>
            <Link
              to={isConnected ? '/dashboard' : '/login'}
              className="rounded-lg bg-indigo-500 px-4 py-2 font-semibold text-white hover:bg-indigo-400"
            >
              {isConnected ? 'Open Dashboard' : 'Connect Freighter'}
            </Link>
          </div>
        </div>

        <div className="mt-16 max-w-3xl">
          <span className="inline-block rounded-full border border-indigo-400/30 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-200">
            Stellar Soroban Non-Custodial DeFi Platform
          </span>
          <h1 className="mt-4 text-4xl font-extrabold tracking-tight sm:text-5xl">
            Attestation-Backed Credit Scoring &amp; Collateralized Lending
          </h1>
          <p className="mt-6 text-lg text-slate-300">
            CreditLedger pairs Ed25519-signed institutional financial attestations, real SEP-41 token
            lending pools, escrowed community vouching, and AES-256-GCM encrypted selective
            disclosure on Stellar Soroban.
          </p>
          <div className="mt-8 flex flex-wrap gap-4">
            <Link
              to={isConnected ? '/dashboard' : '/login'}
              className="rounded-lg bg-indigo-500 px-6 py-3 font-semibold text-white shadow hover:bg-indigo-400"
            >
              {isConnected ? 'Go to Dashboard' : 'Connect Wallet to Start'}
            </Link>
            <Link
              to="/about"
              className="rounded-lg border border-slate-600 px-6 py-3 font-semibold text-slate-200 hover:bg-slate-800"
            >
              View Scoring &amp; Risk Model
            </Link>
          </div>
        </div>

        <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              title: 'Ed25519 Attestations',
              desc: 'Only authorized issuers or Ed25519-signed domain payloads move authoritative scores. Self-reports carry 0 weight.',
            },
            {
              title: 'SEP-41 Lending Pools',
              desc: 'Lenders deposit into shared pools with proportional shares; loans disburse real tokens and amortize interest first.',
            },
            {
              title: 'LTV Collateral Enforcement',
              desc: 'Base-tier loans (scores 50-59) require >=125% SEP-41 collateral lock and fair liquidation with surplus refund.',
            },
            {
              title: 'Escrowed Vouching & Privacy',
              desc: 'Protocol-derived trust weight with time decay, 50% default slash cap, and owner-consented claim disclosure.',
            },
          ].map((card) => (
            <div
              key={card.title}
              className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 backdrop-blur"
            >
              <h2 className="text-base font-semibold text-indigo-300">{card.title}</h2>
              <p className="mt-2 text-sm text-slate-300">{card.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
