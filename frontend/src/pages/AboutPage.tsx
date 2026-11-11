import React from 'react';
import { Link } from 'react-router-dom';
import { STELLAR_CONFIG } from '../config/stellar';

export function AboutPage() {
  return (
    <div className="min-h-screen bg-slate-50 py-12 text-slate-900">
      <div className="mx-auto max-w-4xl px-6">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-3xl font-bold text-slate-900">CreditLedger Protocol Architecture</h1>
          <Link to="/" className="text-sm font-semibold text-indigo-600 hover:underline">
            Back to Home
          </Link>
        </div>

        <div className="space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <section>
            <h2 className="text-lg font-semibold text-slate-900">1. Verifiable Credit Scoring Model v2</h2>
            <p className="mt-2 text-sm text-slate-600">
              Scores range from 0 to 100 and are derived on-chain exclusively from authorized issuer
              attestations, closed Soroban loan outcomes, and escrowed community vouches:
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
              <li>Payment History (Verified Attestations, Category Payment): 35%</li>
              <li>Savings &amp; Reserve Stability (Verified Attestations): 25%</li>
              <li>On-Chain Loan Repayment Track Record: 20%</li>
              <li>Escrowed Community Vouch Weight (with time decay): 10%</li>
              <li>Attested Active Diversity &amp; History Length: 10%</li>
              <li>Loan Default Penalty: -25 points per default</li>
              <li>Self-Reported / Unverified Supplementary Records: 0% authoritiative weight</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900">2. Underwriting &amp; APR Tiers</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg bg-slate-50 p-3 text-sm">
                <strong>Score &gt;= 80 (Prime):</strong> 8% APR, uncollateralized up to protocol cap
              </div>
              <div className="rounded-lg bg-slate-50 p-3 text-sm">
                <strong>Score 70-79 (Standard):</strong> 10% APR, uncollateralized up to tier cap
              </div>
              <div className="rounded-lg bg-slate-50 p-3 text-sm">
                <strong>Score 60-69 (Growth):</strong> 12% APR, uncollateralized up to tier cap
              </div>
              <div className="rounded-lg bg-slate-50 p-3 text-sm">
                <strong>Score 50-59 (Collateralized):</strong> 15% APR, requires &gt;= 125% SEP-41
                collateral (80% max LTV)
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900">3. Non-Custodial Privacy &amp; Security</h2>
            <p className="mt-2 text-sm text-slate-600">
              All borrower, lender, and voucher transactions are built as unsigned Soroban XDRs via{' '}
              <code>rpc.prepareTransaction</code> and signed client-side in Freighter. Off-chain
              supporting evidence is encrypted at rest via AES-256-GCM, hash-committed on-chain,
              and selectively disclosed only under revocable owner consent grants.
            </p>
            <div className="mt-3 rounded-lg bg-slate-900 p-3 font-mono text-xs text-slate-200">
              <div>Network: {STELLAR_CONFIG.network}</div>
              <div>CreditScore: {STELLAR_CONFIG.contracts.creditScore}</div>
              <div>LoanManager: {STELLAR_CONFIG.contracts.loanManager}</div>
              <div>CommunityVouch: {STELLAR_CONFIG.contracts.communityVouch}</div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
