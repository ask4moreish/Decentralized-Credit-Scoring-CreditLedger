import {
  Server,
  Networks,
  TransactionBuilder,
  Operation,
  Keypair,
  Account,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';
import { redisCache } from '../config/redis';

export interface StellarConfig {
  network: Networks;
  horizonUrl: string;
  adminSecret: string;
}

export class StellarService {
  private server: Server;
  private config: StellarConfig;
  private adminKeypair: Keypair;

  constructor() {
    this.config = {
      network: process.env.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
      horizonUrl: process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
      adminSecret: process.env.STELLAR_ADMIN_SECRET || '',
    };

    this.server = new Server(this.config.horizonUrl);
    this.adminKeypair = Keypair.fromSecret(this.config.adminSecret);
  }

  async initialize(): Promise<void> {
    try {
      const account = await this.server.loadAccount(this.adminKeypair.publicKey());
      logger.info(`Connected to Stellar network. Admin account: ${account.accountId()}`);
      await this.cacheContractAddresses();
      logger.info('Stellar service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Stellar service:', error);
      throw error;
    }
  }

  private async cacheContractAddresses(): Promise<void> {
    const contracts = {
      creditScore: process.env.CREDIT_SCORE_CONTRACT || '',
      loanManager: process.env.LOAN_MANAGER_CONTRACT || '',
      communityVouch: process.env.COMMUNITY_VOUCH_CONTRACT || '',
    };
    await redisCache.set('stellar:contracts', contracts, 3600);
  }

  async getContractAddresses(): Promise<{ creditScore: string; loanManager: string; communityVouch: string }> {
    let contracts = await redisCache.get<{ creditScore: string; loanManager: string; communityVouch: string }>('stellar:contracts');
    if (!contracts) {
      await this.cacheContractAddresses();
      contracts = await redisCache.get('stellar:contracts');
    }
    return contracts!;
  }

  async getAccount(accountId: string): Promise<Account> {
    try {
      return await this.server.loadAccount(accountId);
    } catch (error) {
      logger.error(`Failed to load account ${accountId}:`, error);
      throw error;
    }
  }

  async createAccount(newAccountPublicKey: string, startingBalance = '2'): Promise<string> {
    try {
      const adminAccount = await this.server.loadAccount(this.adminKeypair.publicKey());
      const transaction = new TransactionBuilder(adminAccount, {
        fee: await this.server.fetchBaseFee(),
        networkPassphrase: this.config.network,
      })
        .addOperation(Operation.createAccount({ destination: newAccountPublicKey, startingBalance }))
        .setTimeout(30)
        .build();

      transaction.sign(this.adminKeypair);
      const result = await this.server.submitTransaction(transaction);
      logger.info(`Account created: ${newAccountPublicKey}, Transaction: ${result.hash}`);
      return result.hash;
    } catch (error) {
      logger.error(`Failed to create account ${newAccountPublicKey}:`, error);
      throw error;
    }
  }

  async invokeContract(
    contractAddress: string,
    functionName: string,
    args: xdr.ScVal[] = [],
    signer?: Keypair
  ): Promise<{ hash: string; returnValue: any }> {
    try {
      const signerKeypair = signer ?? this.adminKeypair;
      const sourceAccount = await this.server.loadAccount(signerKeypair.publicKey());

      const transaction = new TransactionBuilder(sourceAccount, {
        fee: await this.server.fetchBaseFee(),
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

      transaction.sign(signerKeypair);
      const result = await this.server.submitTransaction(transaction);
      const returnValue = this.parseContractResult(result);

      return { hash: result.hash, returnValue };
    } catch (error) {
      logger.error(`Failed to invoke contract function ${functionName}:`, error);
      throw error;
    }
  }

  private parseContractResult(result: any): any {
    try {
      const meta = result.resultMetaXdr
        ? xdr.TransactionMeta.fromXDR(result.resultMetaXdr, 'base64')
        : null;
      if (!meta) return null;
      const v3 = meta.v3?.();
      const sorobanMeta = v3?.sorobanMeta?.();
      const returnVal = sorobanMeta?.returnValue?.();
      return returnVal ? scValToNative(returnVal) : null;
    } catch (error) {
      logger.error('Failed to parse contract result:', error);
      return null;
    }
  }

  async submitTransaction(transactionXDR: string): Promise<any> {
    try {
      const transaction = TransactionBuilder.fromXDR(transactionXDR, this.config.network);
      const result = await this.server.submitTransaction(transaction);
      logger.info(`Transaction submitted successfully: ${result.hash}`);
      return result;
    } catch (error) {
      logger.error('Failed to submit transaction:', error);
      throw error;
    }
  }

  async simulateTransaction(transactionXDR: string): Promise<any> {
    try {
      const transaction = TransactionBuilder.fromXDR(transactionXDR, this.config.network);
      return await this.server.simulateTransaction(transaction);
    } catch (error) {
      logger.error('Failed to simulate transaction:', error);
      throw error;
    }
  }

  async getTransaction(transactionHash: string): Promise<any> {
    try {
      return await this.server.transactions().transaction(transactionHash).call();
    } catch (error) {
      logger.error(`Failed to get transaction ${transactionHash}:`, error);
      throw error;
    }
  }

  async getAccountTransactions(accountId: string, limit = 10): Promise<any[]> {
    try {
      const transactions = await this.server
        .transactions()
        .forAccount(accountId)
        .limit(limit)
        .order('desc')
        .call();
      return transactions.records;
    } catch (error) {
      logger.error(`Failed to get transactions for account ${accountId}:`, error);
      throw error;
    }
  }

  async getContractEvents(contractAddress: string, limit = 10): Promise<any[]> {
    try {
      const events = await this.server
        .events()
        .forContract(contractAddress)
        .limit(limit)
        .order('desc')
        .call();
      return events.records;
    } catch (error) {
      logger.error(`Failed to get events for contract ${contractAddress}:`, error);
      throw error;
    }
  }

  // ── Credit Score ──────────────────────────────────────────────────────────

  async updatePaymentHistory(userPublicKey: string, payments: any[]): Promise<any> {
    const { creditScore } = await this.getContractAddresses();
    return this.invokeContract(creditScore, 'update_payment_history', [
      new Address(userPublicKey).toScVal(),
      nativeToScVal(
        payments.map((p) => ({
          amount: BigInt(p.amount),
          timestamp: BigInt(p.timestamp),
          payment_type: p.paymentType,
          consistency_score: p.consistencyScore,
        }))
      ),
    ]);
  }

  async updateSavingsData(userPublicKey: string, savings: any): Promise<any> {
    const { creditScore } = await this.getContractAddresses();
    return this.invokeContract(creditScore, 'update_savings_data', [
      new Address(userPublicKey).toScVal(),
      nativeToScVal({
        amount: BigInt(savings.amount),
        timestamp: BigInt(savings.timestamp),
        duration_months: savings.durationMonths,
        regularity_score: savings.regularityScore,
      }),
    ]);
  }

  async getCreditScore(userPublicKey: string): Promise<any> {
    const { creditScore } = await this.getContractAddresses();
    return this.invokeContract(creditScore, 'get_credit_score', [
      new Address(userPublicKey).toScVal(),
    ]);
  }

  // ── Loan Manager ──────────────────────────────────────────────────────────

  async createLoan(borrowerPublicKey: string, amount: string, durationMonths: number): Promise<any> {
    const { loanManager } = await this.getContractAddresses();
    return this.invokeContract(loanManager, 'create_loan', [
      new Address(borrowerPublicKey).toScVal(),
      nativeToScVal(BigInt(amount), { type: 'i128' }),
      nativeToScVal(durationMonths, { type: 'u32' }),
    ]);
  }

  async getLoan(loanId: number): Promise<any> {
    const { loanManager } = await this.getContractAddresses();
    return this.invokeContract(loanManager, 'get_loan', [
      nativeToScVal(loanId, { type: 'u64' }),
    ]);
  }

  async getUserLoans(userPublicKey: string): Promise<any> {
    const { loanManager } = await this.getContractAddresses();
    return this.invokeContract(loanManager, 'get_user_loans', [
      new Address(userPublicKey).toScVal(),
    ]);
  }

  async repayLoan(borrowerPublicKey: string, loanId: number, amount: string): Promise<any> {
    const { loanManager } = await this.getContractAddresses();
    return this.invokeContract(loanManager, 'repay_loan', [
      new Address(borrowerPublicKey).toScVal(),
      nativeToScVal(loanId, { type: 'u64' }),
      nativeToScVal(BigInt(amount), { type: 'i128' }),
    ]);
  }

  async approveLoan(adminPublicKey: string, loanId: number): Promise<any> {
    const { loanManager } = await this.getContractAddresses();
    return this.invokeContract(loanManager, 'approve_loan', [
      new Address(adminPublicKey).toScVal(),
      nativeToScVal(loanId, { type: 'u64' }),
    ]);
  }

  async markDefault(adminPublicKey: string, loanId: number): Promise<any> {
    const { loanManager } = await this.getContractAddresses();
    return this.invokeContract(loanManager, 'mark_default', [
      new Address(adminPublicKey).toScVal(),
      nativeToScVal(loanId, { type: 'u64' }),
    ]);
  }

  async getActiveLoans(): Promise<any> {
    const { loanManager } = await this.getContractAddresses();
    return this.invokeContract(loanManager, 'get_active_loans', []);
  }

  async getLoanStatistics(): Promise<any> {
    const { loanManager } = await this.getContractAddresses();
    return this.invokeContract(loanManager, 'get_loan_statistics', []);
  }

  async canBorrow(userPublicKey: string, amount: string): Promise<boolean> {
    const { loanManager } = await this.getContractAddresses();
    const result = await this.invokeContract(loanManager, 'can_borrow', [
      new Address(userPublicKey).toScVal(),
      nativeToScVal(BigInt(amount), { type: 'i128' }),
    ]);
    return Boolean(result.returnValue);
  }

  // ── Community Vouch ───────────────────────────────────────────────────────

  async createVouch(
    voucherPublicKey: string,
    voucheePublicKey: string,
    amount: string,
    trustScore: number,
    reason: string,
    durationMonths: number
  ): Promise<any> {
    const { communityVouch } = await this.getContractAddresses();
    return this.invokeContract(communityVouch, 'create_vouch', [
      new Address(voucherPublicKey).toScVal(),
      new Address(voucheePublicKey).toScVal(),
      nativeToScVal(BigInt(amount), { type: 'i128' }),
      nativeToScVal(trustScore, { type: 'u32' }),
      nativeToScVal(reason),
      nativeToScVal(durationMonths, { type: 'u32' }),
    ]);
  }

  async getUserVouches(userPublicKey: string): Promise<any> {
    const { communityVouch } = await this.getContractAddresses();
    return this.invokeContract(communityVouch, 'get_user_vouches', [
      new Address(userPublicKey).toScVal(),
    ]);
  }

  async revokeVouch(voucherPublicKey: string, vouchId: number): Promise<any> {
    const { communityVouch } = await this.getContractAddresses();
    return this.invokeContract(communityVouch, 'revoke_vouch', [
      new Address(voucherPublicKey).toScVal(),
      nativeToScVal(vouchId, { type: 'u64' }),
    ]);
  }
}

export const stellarService = new StellarService();
