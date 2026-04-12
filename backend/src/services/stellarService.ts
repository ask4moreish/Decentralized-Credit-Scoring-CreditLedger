import { Server, Networks, TransactionBuilder, Operation, Asset, Keypair, Account } from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';
import { redisCache } from '../config/redis';

export interface StellarConfig {
  network: Networks;
  horizonUrl: string;
  contractAddress: string;
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
      contractAddress: process.env.CREDIT_SCORE_CONTRACT || '',
      adminSecret: process.env.STELLAR_ADMIN_SECRET || '',
    };

    this.server = new Server(this.config.horizonUrl);
    this.adminKeypair = Keypair.fromSecret(this.config.adminSecret);
  }

  async initialize(): Promise<void> {
    try {
      // Test connection to Stellar network
      const account = await this.server.loadAccount(this.adminKeypair.publicKey());
      logger.info(`Connected to Stellar network. Admin account: ${account.accountId()}`);
      
      // Cache contract addresses
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

    await redisCache.set('stellar:contracts', contracts, 3600); // Cache for 1 hour
  }

  async getContractAddresses(): Promise<any> {
    let contracts = await redisCache.get('stellar:contracts');
    
    if (!contracts) {
      await this.cacheContractAddresses();
      contracts = await redisCache.get('stellar:contracts');
    }

    return contracts;
  }

  async submitTransaction(transactionXDR: string): Promise<any> {
    try {
      const transaction = TransactionBuilder.fromXDR(transactionXDR, this.config.network);
      
      // Sign with admin key if required
      if (this.needsAdminSignature(transaction)) {
        transaction.sign(this.adminKeypair);
      }

      const result = await this.server.submitTransaction(transaction);
      logger.info(`Transaction submitted successfully: ${result.hash}`);
      
      return result;
    } catch (error) {
      logger.error('Failed to submit transaction:', error);
      throw error;
    }
  }

  private needsAdminSignature(transaction: any): boolean {
    // Logic to determine if admin signature is needed
    // This would depend on the specific operations in the transaction
    return false; // Placeholder
  }

  async getAccount(accountId: string): Promise<Account> {
    try {
      const account = await this.server.loadAccount(accountId);
      return account;
    } catch (error) {
      logger.error(`Failed to load account ${accountId}:`, error);
      throw error;
    }
  }

  async createAccount(newAccountPublicKey: string, startingBalance: string = '2'): Promise<string> {
    try {
      const adminAccount = await this.server.loadAccount(this.adminKeypair.publicKey());
      
      const transaction = new TransactionBuilder(adminAccount, {
        fee: await this.server.fetchBaseFee(),
        networkPassphrase: this.config.network,
      })
        .addOperation(Operation.createAccount({
          destination: newAccountPublicKey,
          startingBalance,
        }))
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
    args: any[] = [],
    signer?: Keypair
  ): Promise<any> {
    try {
      const sourceAccount = signer 
        ? await this.server.loadAccount(signer.publicKey())
        : await this.server.loadAccount(this.adminKeypair.publicKey());

      const transaction = new TransactionBuilder(sourceAccount, {
        fee: await this.server.fetchBaseFee(),
        networkPassphrase: this.config.network,
      })
        .addOperation(Operation.invokeContractFunction({
          contract: contractAddress,
          function: functionName,
          args,
        }))
        .setTimeout(30)
        .build();

      if (signer) {
        transaction.sign(signer);
      } else {
        transaction.sign(this.adminKeypair);
      }

      const result = await this.server.submitTransaction(transaction);
      
      // Parse the result to get the return value
      const returnValue = this.parseContractResult(result);
      
      return {
        hash: result.hash,
        returnValue,
      };
    } catch (error) {
      logger.error(`Failed to invoke contract function ${functionName}:`, error);
      throw error;
    }
  }

  private parseContractResult(result: any): any {
    // Parse the transaction result to extract contract function return value
    // This is a simplified implementation
    try {
      const operation = result.transaction.operations().find(op => op.type === 'invokeContractFunction');
      return operation?.result || null;
    } catch (error) {
      logger.error('Failed to parse contract result:', error);
      return null;
    }
  }

  async getContractData(contractAddress: string, key: string): Promise<any> {
    try {
      const result = await this.server.getContractData(contractAddress, key);
      return result.val;
    } catch (error) {
      logger.error(`Failed to get contract data for key ${key}:`, error);
      throw error;
    }
  }

  async simulateTransaction(transactionXDR: string): Promise<any> {
    try {
      const transaction = TransactionBuilder.fromXDR(transactionXDR, this.config.network);
      const simulation = await this.server.simulateTransaction(transaction);
      return simulation;
    } catch (error) {
      logger.error('Failed to simulate transaction:', error);
      throw error;
    }
  }

  async getTransaction(transactionHash: string): Promise<any> {
    try {
      const transaction = await this.server.transactions().transaction(transactionHash).call();
      return transaction;
    } catch (error) {
      logger.error(`Failed to get transaction ${transactionHash}:`, error);
      throw error;
    }
  }

  async getAccountTransactions(accountId: string, limit: number = 10): Promise<any[]> {
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

  async getContractEvents(contractAddress: string, limit: number = 10): Promise<any[]> {
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

  // Credit score specific methods
  async updatePaymentHistory(userPublicKey: string, payments: any[]): Promise<any> {
    const contracts = await this.getContractAddresses();
    return this.invokeContract(contracts.creditScore, 'update_payment_history', [
      new Address(userPublicKey).toScVal(),
      payments.map(payment => this.paymentToScVal(payment))
    ]);
  }

  async updateSavingsData(userPublicKey: string, savings: any): Promise<any> {
    const contracts = await this.getContractAddresses();
    return this.invokeContract(contracts.creditScore, 'update_savings_data', [
      new Address(userPublicKey).toScVal(),
      this.savingsToScVal(savings)
    ]);
  }

  async getCreditScore(userPublicKey: string): Promise<any> {
    const contracts = await this.getContractAddresses();
    return this.invokeContract(contracts.creditScore, 'get_credit_score', [
      new Address(userPublicKey).toScVal()
    ]);
  }

  async createLoan(borrowerPublicKey: string, amount: string, durationMonths: number): Promise<any> {
    const contracts = await this.getContractAddresses();
    return this.invokeContract(contracts.loanManager, 'create_loan', [
      new Address(borrowerPublicKey).toScVal(),
      new Address(borrowerPublicKey).toScVal(),
      new Address(amount).toScVal(),
      durationMonths
    ]);
  }

  async createVouch(
    voucherPublicKey: string,
    voucheePublicKey: string,
    amount: string,
    trustScore: number,
    reason: string,
    durationMonths: number
  ): Promise<any> {
    const contracts = await this.getContractAddresses();
    return this.invokeContract(contracts.communityVouch, 'create_vouch', [
      new Address(voucherPublicKey).toScVal(),
      new Address(voucheePublicKey).toScVal(),
      new Address(amount).toScVal(),
      trustScore,
      reason,
      durationMonths
    ]);
  }

  // Helper methods to convert data to Stellar contract format
  private paymentToScVal(payment: any): any {
    // Convert payment data to Stellar ScVal format
    return {
      amount: payment.amount,
      timestamp: payment.timestamp,
      payment_type: payment.paymentType,
      consistency_score: payment.consistencyScore,
    };
  }

  private savingsToScVal(savings: any): any {
    // Convert savings data to Stellar ScVal format
    return {
      amount: savings.amount,
      timestamp: savings.timestamp,
      duration_months: savings.durationMonths,
      regularity_score: savings.regularityScore,
    };
  }
}

export const stellarService = new StellarService();
