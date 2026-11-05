import { db } from '../config/database';
import { logger } from '../utils/logger';

export class DbService {
  async upsertUser(publicKey: string): Promise<void> {
    try {
      await db('users')
        .insert({
          public_key: publicKey,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .onConflict('public_key')
        .merge({
          updated_at: new Date(),
        });
    } catch (error) {
      logger.error(`DbService.upsertUser error for ${publicKey}:`, error);
      // Non-fatal if DB is temporarily unreachable in some test environments
    }
  }

  async getUser(publicKey: string): Promise<any> {
    try {
      return await db('users').where({ public_key: publicKey }).first();
    } catch (error) {
      logger.error(`DbService.getUser error for ${publicKey}:`, error);
      return null;
    }
  }

  async upsertCreditScore(data: {
    publicKey: string;
    score: number;
    paymentHistoryScore?: number;
    savingsScore?: number;
    communityScore?: number;
    activityScore?: number;
  }): Promise<void> {
    try {
      await this.upsertUser(data.publicKey);
      await db('credit_score_cache')
        .insert({
          public_key: data.publicKey,
          score: data.score,
          payment_history_score: data.paymentHistoryScore ?? 0,
          savings_score: data.savingsScore ?? 0,
          community_score: data.communityScore ?? 0,
          activity_score: data.activityScore ?? 0,
          last_updated: new Date(),
        })
        .onConflict('public_key')
        .merge({
          score: data.score,
          payment_history_score: data.paymentHistoryScore ?? 0,
          savings_score: data.savingsScore ?? 0,
          community_score: data.communityScore ?? 0,
          activity_score: data.activityScore ?? 0,
          last_updated: new Date(),
        });
    } catch (error) {
      logger.error(`DbService.upsertCreditScore error for ${data.publicKey}:`, error);
    }
  }

  async getCachedCreditScore(publicKey: string): Promise<any> {
    try {
      return await db('credit_score_cache').where({ public_key: publicKey }).first();
    } catch (error) {
      logger.error(`DbService.getCachedCreditScore error for ${publicKey}:`, error);
      return null;
    }
  }

  async upsertLoan(loan: {
    id: number | string;
    borrowerPublicKey: string;
    amount: string | number;
    interestRate: number;
    durationMonths: number;
    status?: string;
    creditScoreUsed?: number;
    repaidAmount?: string | number;
    dueDate?: Date | null;
  }): Promise<void> {
    try {
      await this.upsertUser(loan.borrowerPublicKey);
      await db('loans')
        .insert({
          id: loan.id,
          borrower_public_key: loan.borrowerPublicKey,
          amount: loan.amount,
          interest_rate: loan.interestRate,
          duration_months: loan.durationMonths,
          status: loan.status || 'pending',
          credit_score_used: loan.creditScoreUsed || 0,
          repaid_amount: loan.repaidAmount || 0,
          due_date: loan.dueDate || null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .onConflict('id')
        .merge({
          status: loan.status || 'pending',
          repaid_amount: loan.repaidAmount || 0,
          updated_at: new Date(),
        });
    } catch (error) {
      logger.error(`DbService.upsertLoan error for loan ${loan.id}:`, error);
    }
  }

  async getLoanById(loanId: number | string): Promise<any> {
    try {
      return await db('loans').where({ id: loanId }).first();
    } catch (error) {
      logger.error(`DbService.getLoanById error for loan ${loanId}:`, error);
      return null;
    }
  }

  async getUserLoans(publicKey: string, status?: string): Promise<any[]> {
    try {
      let query = db('loans').where({ borrower_public_key: publicKey }).orderBy('created_at', 'desc');
      if (status && status !== 'all') {
        query = query.where({ status });
      }
      return await query;
    } catch (error) {
      logger.error(`DbService.getUserLoans error for ${publicKey}:`, error);
      return [];
    }
  }

  async getActiveLoans(): Promise<any[]> {
    try {
      return await db('loans').whereIn('status', ['pending', 'active']).orderBy('created_at', 'desc');
    } catch (error) {
      logger.error('DbService.getActiveLoans error:', error);
      return [];
    }
  }

  async updateLoanStatus(loanId: number | string, status: string, repaidAmount?: string | number): Promise<void> {
    try {
      const updateData: any = {
        status,
        updated_at: new Date(),
      };
      if (repaidAmount !== undefined) {
        updateData.repaid_amount = repaidAmount;
      }
      await db('loans').where({ id: loanId }).update(updateData);
    } catch (error) {
      logger.error(`DbService.updateLoanStatus error for loan ${loanId}:`, error);
    }
  }

  async upsertVouch(vouch: {
    id: number | string;
    voucherKey: string;
    voucheeKey: string;
    amount: string | number;
    trustScore: number;
    reason?: string;
    isActive?: boolean;
    expirationDate?: Date | null;
  }): Promise<void> {
    try {
      await this.upsertUser(vouch.voucherKey);
      await this.upsertUser(vouch.voucheeKey);
      await db('vouches')
        .insert({
          id: vouch.id,
          voucher_key: vouch.voucherKey,
          vouchee_key: vouch.voucheeKey,
          amount: vouch.amount,
          trust_score: vouch.trustScore,
          reason: vouch.reason || null,
          is_active: vouch.isActive ?? true,
          expiration_date: vouch.expirationDate || null,
          created_at: new Date(),
        })
        .onConflict('id')
        .merge({
          is_active: vouch.isActive ?? true,
        });
    } catch (error) {
      logger.error(`DbService.upsertVouch error for vouch ${vouch.id}:`, error);
    }
  }

  async getUserVouches(publicKey: string): Promise<any[]> {
    try {
      return await db('vouches')
        .where({ voucher_key: publicKey })
        .orWhere({ vouchee_key: publicKey })
        .orderBy('created_at', 'desc');
    } catch (error) {
      logger.error(`DbService.getUserVouches error for ${publicKey}:`, error);
      return [];
    }
  }

  async updateVouchStatus(vouchId: number | string, isActive: boolean): Promise<void> {
    try {
      await db('vouches').where({ id: vouchId }).update({ is_active: isActive });
    } catch (error) {
      logger.error(`DbService.updateVouchStatus error for vouch ${vouchId}:`, error);
    }
  }
}

export const dbService = new DbService();
