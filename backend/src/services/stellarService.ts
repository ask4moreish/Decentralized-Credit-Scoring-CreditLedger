import crypto from 'node:crypto';
import {
  Account,
  Address,
  Horizon,
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';
import { redisCache } from '../config/redis';
import { dbService } from './dbService';
import { parseNonNegativeStroops, parseRawU128String } from '../utils/amounts';

export interface StellarConfig {
  network: Networks;
  horizonUrl: string;
  rpcUrl: string;
  adminSecret: string;
}

export interface AttestationPayloadInput {
  attestationIdHex: string;
  subjectPublicKey: string;
  kind: number; // 1=Payment, 2=Savings
  recordCommitmentHex: string;
  metricScore: number;
  amountUnits: string | number;
  durationMonths: number;
  issuedAt: number;
  expiresAt: number;
}

const SIMULATION_DUMMY_PUBLIC_KEY = Keypair.fromRawEd25519Seed(
  Buffer.alloc(32, 1)
).publicKey();

function toSorobanStruct(entries: Array<[string, xdr.ScVal]>): xdr.ScVal {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return xdr.ScVal.scvMap(
    sorted.map(
      ([k, val]) =>
        new xdr.ScMapEntry({
          key: nativeToScVal(k, { type: 'symbol' }),
          val,
        })
    )
  );
}

function u128ScVal(val: string | number | bigint): xdr.ScVal {
  return nativeToScVal(BigInt(parseRawU128String(val)), { type: 'u128' });
}

function bytesScVal(hex: string): xdr.ScVal {
  return nativeToScVal(Buffer.from(hex, 'hex'), { type: 'bytes' });
}

export class StellarService {
  private server: Horizon.Server;
  private rpcServer: rpc.Server;
  private config: StellarConfig;
  private adminKeypair: Keypair | null = null;

  constructor() {
    this.config = {
      network: process.env.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
      horizonUrl: process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
      rpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
      adminSecret: process.env.STELLAR_ADMIN_SECRET || '',
    };

    this.server = new Horizon.Server(this.config.horizonUrl);
    this.rpcServer = new rpc.Server(this.config.rpcUrl);

    if (this.config.adminSecret) {
      try {
        this.adminKeypair = Keypair.fromSecret(this.config.adminSecret);
      } catch {
        logger.warn('Invalid STELLAR_ADMIN_SECRET provided; admin signing disabled');
      }
    }
  }

  getAdminPublicKey(): string | null {
    return this.adminKeypair ? this.adminKeypair.publicKey() : null;
  }

  async initialize(): Promise<void> {
    try {
      if (this.adminKeypair) {
        try {
          const account = await this.server.loadAccount(this.adminKeypair.publicKey());
          logger.info(`Connected to Stellar network. Admin account: ${account.accountId()}`);
        } catch {
          logger.warn(`Admin account ${this.adminKeypair.publicKey()} not funded yet on network`);
        }
      }
      await this.cacheContractAddresses();
      logger.info('Stellar service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Stellar service:', error);
    }
  }

  private async cacheContractAddresses(): Promise<void> {
    const contracts = {
      creditScore: process.env.CREDIT_SCORE_CONTRACT || '',
      loanManager: process.env.LOAN_MANAGER_CONTRACT || '',
      communityVouch: process.env.COMMUNITY_VOUCH_CONTRACT || '',
      assetToken: process.env.LOAN_TOKEN_CONTRACT || process.env.ASSET_TOKEN_CONTRACT || '',
    };
    await redisCache.set('stellar:contracts', contracts, 3600);
  }

  async getContractAddresses(): Promise<{
    creditScore: string;
    loanManager: string;
    communityVouch: string;
    assetToken: string;
  }> {
    const envContracts = {
      creditScore: process.env.CREDIT_SCORE_CONTRACT || '',
      loanManager: process.env.LOAN_MANAGER_CONTRACT || '',
      communityVouch: process.env.COMMUNITY_VOUCH_CONTRACT || '',
      assetToken: process.env.LOAN_TOKEN_CONTRACT || process.env.ASSET_TOKEN_CONTRACT || '',
    };
    if (envContracts.creditScore || envContracts.loanManager || envContracts.communityVouch) {
      return envContracts;
    }
    const cached = await redisCache.get<typeof envContracts>('stellar:contracts');
    return cached || envContracts;
  }

  async getAccount(accountId: string): Promise<Account> {
    return await this.server.loadAccount(accountId);
  }

  /**
   * Read-only Soroban RPC simulation (no sequence consumption, no transaction fees, no signer needed).
   */
  async simulateReadOnly(
    contractAddress: string,
    functionName: string,
    args: xdr.ScVal[] = []
  ): Promise<any> {
    if (!contractAddress) {
      throw new Error(`Contract address missing for read call ${functionName}`);
    }
    const dummyAccount = new Account(SIMULATION_DUMMY_PUBLIC_KEY, '0');
    const tx = new TransactionBuilder(dummyAccount, {
      fee: '100',
      networkPassphrase: this.config.network,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractAddress,
          function: functionName,
          args,
        })
      )
      .setTimeout(30)
      .build();

    const sim = await this.rpcServer.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`Soroban read simulation failed for ${functionName}: ${sim.error}`);
    }
    if (!sim.result?.retval) {
      return null;
    }
    return scValToNative(sim.result.retval);
  }

  /**
   * Builds and prepares an unsigned Soroban contract invocation transaction via rpc.prepareTransaction()
   * so the returned XDR contains valid resource footprints, authorization entries, and minResourceFee.
   */
  async buildInvokeContractTransaction(
    sourcePublicKey: string,
    contractAddress: string,
    functionName: string,
    args: xdr.ScVal[] = []
  ): Promise<string> {
    if (!contractAddress) {
      throw new Error(`Contract address missing for operation ${functionName}`);
    }

    let sourceAccount: Account;
    try {
      sourceAccount = await this.rpcServer.getAccount(sourcePublicKey);
    } catch {
      sourceAccount = await this.server.loadAccount(sourcePublicKey);
    }

    const rawTx = new TransactionBuilder(sourceAccount, {
      fee: '100000',
      networkPassphrase: this.config.network,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractAddress,
          function: functionName,
          args,
        })
      )
      .setTimeout(300)
      .build();

    const prepared = await this.rpcServer.prepareTransaction(rawTx);
    return prepared.toXDR();
  }

  /**
   * Signs & submits an admin-authorized Soroban contract transaction (used exclusively for
   * governance functions such as approve_loan, mark_default, or register_issuer).
   */
  async invokeAdminContract(
    contractAddress: string,
    functionName: string,
    args: xdr.ScVal[] = [],
    signer?: Keypair
  ): Promise<{ hash: string; ledger: number | null; returnValue: any }> {
    const signerKeypair = signer ?? this.adminKeypair;
    if (!signerKeypair) {
      throw new Error('Admin keypair is not configured');
    }
    if (!contractAddress) {
      throw new Error(`Contract address missing for ${functionName}`);
    }

    const sourceAccount = await this.rpcServer.getAccount(signerKeypair.publicKey());
    const rawTx = new TransactionBuilder(sourceAccount, {
      fee: '100000',
      networkPassphrase: this.config.network,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractAddress,
          function: functionName,
          args,
        })
      )
      .setTimeout(60)
      .build();

    const prepared = await this.rpcServer.prepareTransaction(rawTx);
    prepared.sign(signerKeypair);
    return await this.submitTransaction(prepared.toXDR());
  }

  /**
   * Submits a signed XDR via Soroban JSON-RPC and polls until confirmed (SUCCESS) or FAILED.
   * Never reports an unconfirmed/pending transaction as confirmed success.
   */
  async submitTransaction(
    signedXDR: string
  ): Promise<{ hash: string; ledger: number | null; returnValue: any }> {
    const parsedTx = TransactionBuilder.fromXDR(signedXDR, this.config.network);
    const sendRes = await this.rpcServer.sendTransaction(parsedTx);
    if (sendRes.status === 'ERROR') {
      throw new Error(`Transaction rejected by Soroban RPC: ${JSON.stringify(sendRes.errorResult || sendRes)}`);
    }

    const txHash = sendRes.hash;
    for (let attempt = 0; attempt < 20; attempt++) {
      const rpcTx = await this.queryTransactionJsonRpc(txHash);
      if (rpcTx.status === 'SUCCESS') {
        const returnValue = this.parseContractReturnFromRpc(rpcTx);
        return {
          hash: txHash,
          ledger: typeof rpcTx.ledger === 'number' ? rpcTx.ledger : null,
          returnValue,
        };
      }
      if (rpcTx.status === 'FAILED') {
        throw new Error(`On-chain transaction ${txHash} FAILED: ${rpcTx.resultXdr || 'execution failed'}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    throw new Error(`Transaction ${txHash} did not finalize within confirmation window`);
  }

  /**
   * Direct JSON-RPC `getTransaction` avoids Protocol 22/23 js-xdr union switch parsing issues.
   */
  async queryTransactionJsonRpc(txHash: string): Promise<{
    status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
    ledger?: number;
    resultXdr?: string;
    resultMetaXdr?: string;
  }> {
    const res = await fetch(this.config.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: { hash: txHash },
      }),
    });
    if (!res.ok) {
      throw new Error(`Soroban RPC getTransaction HTTP ${res.status}`);
    }
    const json = (await res.json()) as { error?: any; result?: any };
    if (json.error) {
      throw new Error(`Soroban RPC error: ${JSON.stringify(json.error)}`);
    }
    return json.result || { status: 'NOT_FOUND' };
  }

  private parseContractReturnFromRpc(rpcTx: {
    resultMetaXdr?: string;
    diagnosticEventsXdr?: string[];
  }): any {
    // Prefer diagnosticEventsXdr last `fn_return` event (works across Protocol 20-24 / Meta v4)
    if (Array.isArray(rpcTx.diagnosticEventsXdr)) {
      for (let i = rpcTx.diagnosticEventsXdr.length - 1; i >= 0; i--) {
        try {
          const diag = xdr.DiagnosticEvent.fromXDR(rpcTx.diagnosticEventsXdr[i], 'base64');
          const ev = diag.event();
          const v0 = ev.body()?.v0?.();
          const topics = v0?.topics?.() || [];
          if (topics.length > 0 && scValToNative(topics[0]) === 'fn_return') {
            return scValToNative(v0.data());
          }
        } catch {
          // Continue scanning other events
        }
      }
    }
    try {
      if (!rpcTx.resultMetaXdr) return null;
      const meta = xdr.TransactionMeta.fromXDR(rpcTx.resultMetaXdr, 'base64');
      const v3 = meta.v3?.();
      const sorobanMeta = v3?.sorobanMeta?.();
      const ret = sorobanMeta?.returnValue?.();
      return ret ? scValToNative(ret) : null;
    } catch {
      return null;
    }
  }

  async reconcilePendingTransactions(): Promise<{ reconciled: number; failed: number }> {
    const pending = await dbService.getPendingStellarTxs(20);
    let reconciled = 0;
    let failed = 0;

    for (const tx of pending) {
      try {
        const rpcRes = await this.queryTransactionJsonRpc(tx.tx_hash);
        if (rpcRes.status === 'SUCCESS') {
          await dbService.updateStellarTxReconciliation(tx.tx_hash, 'confirmed', rpcRes.ledger ?? null, null);
          reconciled++;
        } else if (rpcRes.status === 'FAILED') {
          await dbService.updateStellarTxReconciliation(
            tx.tx_hash,
            'failed',
            rpcRes.ledger ?? null,
            rpcRes.resultXdr || 'On-chain transaction failed'
          );
          failed++;
        } else {
          await dbService.updateStellarTxReconciliation(tx.tx_hash, 'pending', null, 'Not yet confirmed');
        }
      } catch (err) {
        await dbService.updateStellarTxReconciliation(
          tx.tx_hash,
          'pending',
          null,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    return { reconciled, failed };
  }

  // ── Off-Chain Attestation Signing Helper (Ed25519 matching Rust contract) ─

  buildAttestationSigningMessage(
    contractAddress: string,
    issuerPublicKey: string,
    input: AttestationPayloadInput
  ): Buffer {
    const prefix = Buffer.from('CREDITLEDGER-ATTEST-V1', 'utf8');
    const contractXdr = new Address(contractAddress).toScVal().toXDR();
    const attIdBuf = Buffer.from(input.attestationIdHex, 'hex');
    const subjectXdr = new Address(input.subjectPublicKey).toScVal().toXDR();
    const issuerXdr = new Address(issuerPublicKey).toScVal().toXDR();

    const kindBuf = Buffer.alloc(4);
    kindBuf.writeUInt32BE(input.kind, 0);

    const commitBuf = Buffer.from(input.recordCommitmentHex, 'hex');

    const metricBuf = Buffer.alloc(4);
    metricBuf.writeUInt32BE(input.metricScore, 0);

    const amountBuf = Buffer.alloc(16);
    let rem = BigInt(parseRawU128String(input.amountUnits));
    for (let i = 15; i >= 0; i--) {
      amountBuf[i] = Number(rem & 0xffn);
      rem >>= 8n;
    }

    const durBuf = Buffer.alloc(4);
    durBuf.writeUInt32BE(input.durationMonths, 0);

    const issuedBuf = Buffer.alloc(8);
    issuedBuf.writeBigUInt64BE(BigInt(input.issuedAt), 0);

    const expBuf = Buffer.alloc(8);
    expBuf.writeBigUInt64BE(BigInt(input.expiresAt), 0);

    return Buffer.concat([
      prefix,
      contractXdr,
      attIdBuf,
      subjectXdr,
      issuerXdr,
      kindBuf,
      commitBuf,
      metricBuf,
      amountBuf,
      durBuf,
      issuedBuf,
      expBuf,
    ]);
  }

  signAttestationWithKeypair(
    contractAddress: string,
    issuerKeypair: Keypair,
    input: AttestationPayloadInput
  ): string {
    const message = this.buildAttestationSigningMessage(
      contractAddress,
      issuerKeypair.publicKey(),
      input
    );
    return issuerKeypair.sign(message).toString('hex');
  }

  private buildAttestationInputScVal(input: AttestationPayloadInput): xdr.ScVal {
    return toSorobanStruct([
      ['attestation_id', bytesScVal(input.attestationIdHex)],
      ['subject', new Address(input.subjectPublicKey).toScVal()],
      ['kind', nativeToScVal(input.kind, { type: 'u32' })],
      ['record_commitment', bytesScVal(input.recordCommitmentHex)],
      ['metric_score', nativeToScVal(input.metricScore, { type: 'u32' })],
      ['amount_units', u128ScVal(input.amountUnits)],
      ['duration_months', nativeToScVal(input.durationMonths, { type: 'u32' })],
      ['issued_at', nativeToScVal(BigInt(input.issuedAt), { type: 'u64' })],
      ['expires_at', nativeToScVal(BigInt(input.expiresAt), { type: 'u64' })],
    ]);
  }

  // ── Credit Score Contract Operations ──────────────────────────────────────

  async prepareSubmitSignedAttestationTx(
    subjectPublicKey: string,
    issuerPublicKey: string,
    input: AttestationPayloadInput,
    signatureHex: string
  ): Promise<string> {
    const { creditScore } = await this.getContractAddresses();
    return this.buildInvokeContractTransaction(
      subjectPublicKey,
      creditScore,
      'submit_signed_attestation',
      [
        new Address(subjectPublicKey).toScVal(),
        new Address(issuerPublicKey).toScVal(),
        this.buildAttestationInputScVal(input),
        bytesScVal(signatureHex),
      ]
    );
  }

  async prepareSubmitSelfReportedTx(
    userPublicKey: string,
    input: {
      kind: number;
      recordCommitmentHex: string;
      claimedAmount: string | number;
      claimedMetric: number;
      durationMonths: number;
      timestamp: number;
    }
  ): Promise<string> {
    const { creditScore } = await this.getContractAddresses();
    return this.buildInvokeContractTransaction(
      userPublicKey,
      creditScore,
      'submit_self_reported_record',
      [
        new Address(userPublicKey).toScVal(),
        toSorobanStruct([
          ['kind', nativeToScVal(input.kind, { type: 'u32' })],
          ['record_commitment', bytesScVal(input.recordCommitmentHex)],
          ['claimed_amount', u128ScVal(parseNonNegativeStroops(input.claimedAmount))],
          ['claimed_metric', nativeToScVal(input.claimedMetric, { type: 'u32' })],
          ['duration_months', nativeToScVal(input.durationMonths, { type: 'u32' })],
          ['timestamp', nativeToScVal(BigInt(input.timestamp), { type: 'u64' })],
        ]),
      ]
    );
  }

  async registerIssuer(params: {
    issuerPublicKey: string;
    verificationKeyHex?: string;
    category: number;
    name: string;
    metadataUri: string;
  }) {
    const { creditScore } = await this.getContractAddresses();
    const rawKey =
      params.verificationKeyHex ||
      Keypair.fromPublicKey(params.issuerPublicKey).rawPublicKey().toString('hex');
    return this.invokeAdminContract(creditScore, 'register_issuer', [
      new Address(params.issuerPublicKey).toScVal(),
      bytesScVal(rawKey),
      nativeToScVal(params.category, { type: 'u32' }),
      nativeToScVal(params.name, { type: 'string' }),
      nativeToScVal(params.metadataUri, { type: 'string' }),
    ]);
  }

  async revokeIssuer(issuerPublicKey: string) {
    const { creditScore } = await this.getContractAddresses();
    return this.invokeAdminContract(creditScore, 'revoke_issuer', [
      new Address(issuerPublicKey).toScVal(),
    ]);
  }

  async getCreditScore(userPublicKey: string): Promise<{ returnValue: any }> {
    const { creditScore } = await this.getContractAddresses();
    const returnValue = await this.simulateReadOnly(creditScore, 'get_credit_score', [
      new Address(userPublicKey).toScVal(),
    ]);
    return { returnValue };
  }

  async getScoreBreakdown(userPublicKey: string): Promise<{ returnValue: any }> {
    const { creditScore } = await this.getContractAddresses();
    const returnValue = await this.simulateReadOnly(creditScore, 'get_score_breakdown', [
      new Address(userPublicKey).toScVal(),
    ]);
    return { returnValue };
  }

  // ── Loan Manager Contract Operations ──────────────────────────────────────

  async prepareDepositLiquidityTx(lenderPublicKey: string, amountStroops: string): Promise<string> {
    const { loanManager } = await this.getContractAddresses();
    return this.buildInvokeContractTransaction(lenderPublicKey, loanManager, 'deposit_liquidity', [
      new Address(lenderPublicKey).toScVal(),
      u128ScVal(amountStroops),
    ]);
  }

  async prepareWithdrawLiquidityTx(lenderPublicKey: string, amountStroops: string): Promise<string> {
    const { loanManager } = await this.getContractAddresses();
    return this.buildInvokeContractTransaction(lenderPublicKey, loanManager, 'withdraw_liquidity', [
      new Address(lenderPublicKey).toScVal(),
      u128ScVal(amountStroops),
    ]);
  }

  async prepareCreateLoanTx(
    borrowerPublicKey: string,
    amountStroops: string,
    durationMonths: number,
    collateralStroops = '0'
  ): Promise<string> {
    const { loanManager } = await this.getContractAddresses();
    return this.buildInvokeContractTransaction(borrowerPublicKey, loanManager, 'create_loan', [
      new Address(borrowerPublicKey).toScVal(),
      u128ScVal(amountStroops),
      nativeToScVal(durationMonths, { type: 'u32' }),
      u128ScVal(collateralStroops),
    ]);
  }

  async prepareCancelLoanTx(borrowerPublicKey: string, loanId: number): Promise<string> {
    const { loanManager } = await this.getContractAddresses();
    return this.buildInvokeContractTransaction(borrowerPublicKey, loanManager, 'cancel_loan', [
      new Address(borrowerPublicKey).toScVal(),
      nativeToScVal(BigInt(loanId), { type: 'u64' }),
    ]);
  }

  async prepareRepayLoanTx(
    borrowerPublicKey: string,
    loanId: number,
    amountStroops: string
  ): Promise<string> {
    const { loanManager } = await this.getContractAddresses();
    return this.buildInvokeContractTransaction(borrowerPublicKey, loanManager, 'repay_loan', [
      new Address(borrowerPublicKey).toScVal(),
      nativeToScVal(BigInt(loanId), { type: 'u64' }),
      u128ScVal(amountStroops),
    ]);
  }

  async getLoan(loanId: number): Promise<{ returnValue: any }> {
    const { loanManager } = await this.getContractAddresses();
    const returnValue = await this.simulateReadOnly(loanManager, 'get_loan', [
      nativeToScVal(BigInt(loanId), { type: 'u64' }),
    ]);
    return { returnValue };
  }

  async getUserLoans(userPublicKey: string, cursor = 0, limit = 50): Promise<{ returnValue: any }> {
    const { loanManager } = await this.getContractAddresses();
    const returnValue = await this.simulateReadOnly(loanManager, 'get_user_loans_page', [
      new Address(userPublicKey).toScVal(),
      nativeToScVal(cursor, { type: 'u32' }),
      nativeToScVal(limit, { type: 'u32' }),
    ]);
    return { returnValue };
  }

  async getPoolState(): Promise<{ returnValue: any }> {
    const { loanManager } = await this.getContractAddresses();
    const returnValue = await this.simulateReadOnly(loanManager, 'get_pool_state', []);
    return { returnValue };
  }

  async getLenderBalance(lenderPublicKey: string): Promise<string> {
    const { loanManager } = await this.getContractAddresses();
    const res = await this.simulateReadOnly(loanManager, 'get_lender_balance', [
      new Address(lenderPublicKey).toScVal(),
    ]);
    return res !== null && res !== undefined ? String(res) : '0';
  }

  async getRequiredCollateral(borrowerPublicKey: string, amountStroops: string): Promise<string> {
    const { loanManager } = await this.getContractAddresses();
    const res = await this.simulateReadOnly(loanManager, 'get_required_collateral', [
      new Address(borrowerPublicKey).toScVal(),
      u128ScVal(amountStroops),
    ]);
    return res !== null && res !== undefined ? String(res) : '0';
  }

  async getRepaymentSchedule(loanId: number): Promise<any> {
    const { loanManager } = await this.getContractAddresses();
    return this.simulateReadOnly(loanManager, 'get_repayment_schedule', [
      nativeToScVal(BigInt(loanId), { type: 'u64' }),
    ]);
  }

  async approveLoan(adminPublicKey: string, loanId: number) {
    const { loanManager } = await this.getContractAddresses();
    return this.invokeAdminContract(loanManager, 'approve_loan', [
      new Address(adminPublicKey).toScVal(),
      nativeToScVal(BigInt(loanId), { type: 'u64' }),
    ]);
  }

  async markDefault(adminPublicKey: string, loanId: number) {
    const { loanManager } = await this.getContractAddresses();
    return this.invokeAdminContract(loanManager, 'mark_default', [
      new Address(adminPublicKey).toScVal(),
      nativeToScVal(BigInt(loanId), { type: 'u64' }),
    ]);
  }

  async getActiveLoans(cursor = 0, limit = 50): Promise<{ returnValue: any }> {
    const { loanManager } = await this.getContractAddresses();
    const returnValue = await this.simulateReadOnly(loanManager, 'get_active_loans_page', [
      nativeToScVal(cursor, { type: 'u32' }),
      nativeToScVal(limit, { type: 'u32' }),
    ]);
    return { returnValue };
  }

  async getLoanStatistics(): Promise<{ returnValue: any }> {
    const { loanManager } = await this.getContractAddresses();
    const returnValue = await this.simulateReadOnly(loanManager, 'get_loan_statistics', []);
    return { returnValue };
  }

  async canBorrow(userPublicKey: string, amountStroops: string): Promise<boolean> {
    const { loanManager } = await this.getContractAddresses();
    const result = await this.simulateReadOnly(loanManager, 'can_borrow', [
      new Address(userPublicKey).toScVal(),
      u128ScVal(amountStroops),
    ]);
    return Boolean(result);
  }

  // ── Community Vouch Contract Operations ───────────────────────────────────

  async prepareCreateVouchTx(
    voucherPublicKey: string,
    voucheePublicKey: string,
    amountStroops: string,
    reason: string,
    durationMonths: number
  ): Promise<string> {
    const { communityVouch } = await this.getContractAddresses();
    return this.buildInvokeContractTransaction(voucherPublicKey, communityVouch, 'create_vouch', [
      new Address(voucherPublicKey).toScVal(),
      new Address(voucheePublicKey).toScVal(),
      u128ScVal(amountStroops),
      nativeToScVal(reason, { type: 'string' }),
      nativeToScVal(durationMonths, { type: 'u32' }),
    ]);
  }

  async prepareRevokeVouchTx(voucherPublicKey: string, vouchId: number): Promise<string> {
    const { communityVouch } = await this.getContractAddresses();
    return this.buildInvokeContractTransaction(voucherPublicKey, communityVouch, 'revoke_vouch', [
      new Address(voucherPublicKey).toScVal(),
      nativeToScVal(BigInt(vouchId), { type: 'u64' }),
    ]);
  }

  async prepareExpireVouchTx(callerPublicKey: string, vouchId: number): Promise<string> {
    const { communityVouch } = await this.getContractAddresses();
    return this.buildInvokeContractTransaction(callerPublicKey, communityVouch, 'expire_vouch', [
      new Address(callerPublicKey).toScVal(),
      nativeToScVal(BigInt(vouchId), { type: 'u64' }),
    ]);
  }

  async prepareWithdrawRemainingVouchTx(voucherPublicKey: string, vouchId: number): Promise<string> {
    const { communityVouch } = await this.getContractAddresses();
    return this.buildInvokeContractTransaction(
      voucherPublicKey,
      communityVouch,
      'withdraw_remaining_escrow',
      [new Address(voucherPublicKey).toScVal(), nativeToScVal(BigInt(vouchId), { type: 'u64' })]
    );
  }

  async getUserVouches(userPublicKey: string): Promise<{ returnValue: any }> {
    const { communityVouch } = await this.getContractAddresses();
    const returnValue = await this.simulateReadOnly(communityVouch, 'get_user_vouches_page', [
      new Address(userPublicKey).toScVal(),
      nativeToScVal(0, { type: 'u32' }),
      nativeToScVal(50, { type: 'u32' }),
    ]);
    return { returnValue };
  }

  async getVouch(vouchId: number): Promise<{ returnValue: any }> {
    const { communityVouch } = await this.getContractAddresses();
    const returnValue = await this.simulateReadOnly(communityVouch, 'get_vouch', [
      nativeToScVal(BigInt(vouchId), { type: 'u64' }),
    ]);
    return { returnValue };
  }

  async getVouchStatistics(userPublicKey: string): Promise<{ returnValue: any }> {
    const { communityVouch } = await this.getContractAddresses();
    const returnValue = await this.simulateReadOnly(communityVouch, 'get_vouch_statistics', [
      new Address(userPublicKey).toScVal(),
    ]);
    return { returnValue };
  }
}

export const stellarService = new StellarService();
export { crypto as _nodeCryptoRef };
