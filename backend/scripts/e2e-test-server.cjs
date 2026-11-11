// E2E Test Backend Server: boots compiled production Express routes & security middleware
// while emulating on-chain Soroban contract state cleanly for deterministic browser E2E.
process.env.NODE_ENV = 'test';
process.env.STELLAR_NETWORK = 'testnet';
process.env.CORS_ORIGINS = 'http://127.0.0.1:4173,http://localhost:4173,http://127.0.0.1:5173,http://localhost:5173';
process.env.CREDIT_SCORE_CONTRACT = 'CBYH6SQZBYC7MWH4QF6FRGCKH2SW5EQD24RLK3EKOTMM5EYSQB7J65BZ';
process.env.LOAN_MANAGER_CONTRACT = 'CDO44SYFPU7SCP4BFTJTWFL2Z7BDB4MVOSSUSW6JUXSPB37ZIAZ7FHKA';
process.env.COMMUNITY_VOUCH_CONTRACT = 'CCZNGFWUX5YFTRP7Y2N7I4TFTNS6YV4243NZ62LLQXGSXLIQTB2XP552';

const { Keypair } = require('@stellar/stellar-sdk');

// Use caller-supplied ephemeral E2E admin allowlist when provided (otherwise random ephemeral)
const fallbackAdmin = Keypair.random();
if (!process.env.ADMIN_PUBLIC_KEYS) {
  process.env.ADMIN_PUBLIC_KEYS = fallbackAdmin.publicKey();
}
if (!process.env.ISSUER_PUBLIC_KEYS) {
  process.env.ISSUER_PUBLIC_KEYS = process.env.ADMIN_PUBLIC_KEYS;
}

const { app } = require('../dist/index');
const { stellarService } = require('../dist/services/stellarService');
const { dbService } = require('../dist/services/dbService');

// Deterministic in-memory chain state backing Soroban RPC hooks during local Playwright E2E
let ledgerSeq = 5700000;
let poolAvailable = 50000000000n; // 5000 XLM
let poolOutstanding = 0n;
const lenderBalances = new Map();
const loans = new Map();
let nextLoanId = 1;
const vouches = new Map();
let nextVouchId = 1;

function nextHash(prefix) {
  ledgerSeq += 1;
  return `${prefix}_${ledgerSeq}`.padEnd(64, '0').slice(0, 64);
}

stellarService.getAccount = async (publicKey) => ({ accountId: () => publicKey });
stellarService.getScoreBreakdown = async () => ({
  returnValue: {
    model_version: 2,
    score: 84,
    payment_history_score: 90,
    savings_score: 82,
    repayment_score: 80,
    community_score: 75,
    activity_score: 78,
    default_penalty: 0,
    verified_payment_count: 2,
    verified_savings_count: 1,
    active_vouch_count: 1,
    self_reported_count: 0,
    last_updated: Math.floor(Date.now() / 1000),
  },
});
stellarService.getCreditScore = stellarService.getScoreBreakdown;
stellarService.canBorrow = async () => true;
stellarService.getRequiredCollateral = async () => '0';
stellarService.getPoolState = async () => ({
  returnValue: {
    total_shares: poolAvailable + poolOutstanding,
    available_cash: poolAvailable,
    outstanding_principal: poolOutstanding,
    total_interest_earned: 80000000n,
    total_collateral_locked: 0n,
    total_defaulted_principal: 0n,
    total_recovered: 0n,
  },
});
stellarService.getLenderBalance = async (key) => String(lenderBalances.get(key) || 0n);

stellarService.prepareDepositLiquidityTx = async (lender, amountStroops) =>
  `UNSIGNED_DEPOSIT:${lender}:${amountStroops}`;
stellarService.prepareWithdrawLiquidityTx = async (lender, amountStroops) =>
  `UNSIGNED_WITHDRAW:${lender}:${amountStroops}`;
stellarService.prepareCreateLoanTx = async (borrower, amountStroops, dur, colStroops) =>
  `UNSIGNED_CREATE_LOAN:${borrower}:${amountStroops}:${dur}:${colStroops}`;
stellarService.prepareCancelLoanTx = async (borrower, loanId) =>
  `UNSIGNED_CANCEL_LOAN:${borrower}:${loanId}`;
stellarService.prepareRepayLoanTx = async (borrower, loanId, amountStroops) =>
  `UNSIGNED_REPAY_LOAN:${borrower}:${loanId}:${amountStroops}`;
stellarService.prepareCreateVouchTx = async (voucher, vouchee, amountStroops, reason, dur) =>
  `UNSIGNED_CREATE_VOUCH:${voucher}:${vouchee}:${amountStroops}:${dur}:${reason}`;
stellarService.prepareRevokeVouchTx = async (voucher, vouchId) =>
  `UNSIGNED_REVOKE_VOUCH:${voucher}:${vouchId}`;
stellarService.prepareExpireVouchTx = async (caller, vouchId) =>
  `UNSIGNED_EXPIRE_VOUCH:${caller}:${vouchId}`;
stellarService.prepareWithdrawRemainingVouchTx = async (voucher, vouchId) =>
  `UNSIGNED_WITHDRAW_VOUCH:${voucher}:${vouchId}`;
stellarService.prepareSubmitSelfReportedTx = async (user) => `UNSIGNED_SUPP:${user}`;

stellarService.getLoan = async (id) => ({ returnValue: loans.get(Number(id)) || null });
stellarService.getUserLoans = async () => ({ returnValue: Array.from(loans.keys()) });
stellarService.getActiveLoans = async () => ({ returnValue: Array.from(loans.values()) });
stellarService.getLoanStatistics = async () => ({ returnValue: { total: loans.size, active: Array.from(loans.values()).filter((l) => l.status === 'Active').length } });
stellarService.approveLoan = async (_admin, loanId) => {
  const loan = loans.get(Number(loanId));
  if (loan) {
    loan.status = 'Active';
    poolOutstanding += BigInt(loan.amount);
  }
  return { hash: nextHash('e2e_approve'), ledger: ledgerSeq, returnValue: null };
};
stellarService.markDefault = async (_admin, loanId) => {
  const loan = loans.get(Number(loanId));
  if (loan) {
    loan.status = 'Defaulted';
    loan.collateral_locked = false;
  }
  return { hash: nextHash('e2e_default'), ledger: ledgerSeq, returnValue: null };
};
stellarService.getVouch = async (id) => ({ returnValue: vouches.get(Number(id)) || null });
stellarService.getUserVouches = async () => ({ returnValue: Array.from(vouches.keys()) });

stellarService.submitTransaction = async (signedXDR) => {
  // Parse simulated tag payload: e.g. SIGNED::UNSIGNED_CREATE_LOAN:G...:1000000000:12:0
  const raw = String(signedXDR).replace(/^SIGNED::/, '');
  const parts = raw.split(':');
  const op = parts[0];

  if (op === 'UNSIGNED_DEPOSIT') {
    const lender = parts[1];
    const amt = BigInt(parts[2]);
    poolAvailable += amt;
    lenderBalances.set(lender, (lenderBalances.get(lender) || 0n) + amt);
    return { hash: nextHash('e2e_dep'), ledger: ledgerSeq, returnValue: amt.toString() };
  }
  if (op === 'UNSIGNED_WITHDRAW') {
    const lender = parts[1];
    const amt = BigInt(parts[2]);
    const prev = lenderBalances.get(lender) || 0n;
    const next = prev > amt ? prev - amt : 0n;
    lenderBalances.set(lender, next);
    poolAvailable = poolAvailable > amt ? poolAvailable - amt : 0n;
    return { hash: nextHash('e2e_wit'), ledger: ledgerSeq, returnValue: amt.toString() };
  }
  if (op === 'UNSIGNED_CREATE_LOAN') {
    const id = nextLoanId++;
    const [, borrower, amount, durationMonths, collateralAmount] = parts;
    loans.set(id, {
      id,
      borrower,
      amount: BigInt(amount),
      interest_rate: 8,
      duration_months: Number(durationMonths),
      status: 'Pending',
      credit_score_used: 84,
      collateral_amount: BigInt(collateralAmount),
      collateral_locked: BigInt(collateralAmount) > 0n,
      repaid_amount: 0n,
      scheduled_interest: (BigInt(amount) * 8n) / 100n,
    });
    await dbService.upsertLoan({
      id,
      borrowerPublicKey: borrower,
      amount: String(amount),
      interestRate: 8,
      durationMonths: Number(durationMonths),
      status: 'active',
      creditScoreUsed: 84,
      collateralAmount: String(collateralAmount),
      collateralLocked: BigInt(collateralAmount) > 0n,
    });
    return { hash: nextHash('e2e_loan'), ledger: ledgerSeq, returnValue: id };
  }
  if (op === 'UNSIGNED_REPAY_LOAN') {
    const [, , loanIdStr, amtStr] = parts;
    const loan = loans.get(Number(loanIdStr));
    if (loan) {
      loan.repaid_amount += BigInt(amtStr);
      if (loan.repaid_amount >= loan.amount) {
        loan.status = 'Repaid';
        loan.collateral_locked = false;
      }
    }
    return { hash: nextHash('e2e_repay'), ledger: ledgerSeq, returnValue: loan };
  }
  if (op === 'UNSIGNED_CREATE_VOUCH') {
    const id = nextVouchId++;
    const [, voucher, vouchee, amount, , reason] = parts;
    vouches.set(id, {
      id,
      voucher,
      vouchee,
      amount: BigInt(amount),
      escrowed_balance: BigInt(amount),
      slashed_amount: 0n,
      trust_score: 82,
      reason,
      is_active: true,
      withdrawn: false,
    });
    return { hash: nextHash('e2e_vouch'), ledger: ledgerSeq, returnValue: id };
  }
  if (op === 'UNSIGNED_REVOKE_VOUCH') {
    const vouchId = Number(parts[2]);
    const v = vouches.get(vouchId);
    if (v) {
      v.is_active = false;
      v.withdrawn = true;
      v.escrowed_balance = 0n;
    }
    return { hash: nextHash('e2e_revv'), ledger: ledgerSeq, returnValue: null };
  }
  return { hash: nextHash('e2e_tx'), ledger: ledgerSeq, returnValue: null };
};

const port = Number(process.env.E2E_BACKEND_PORT || 3001);
app.listen(port, '127.0.0.1', () => {
  console.log(`E2E CreditLedger Backend listening on http://127.0.0.1:${port}`);
});
