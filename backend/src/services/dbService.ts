import { Knex } from 'knex';
import { db, isDatabaseAvailable } from '../config/database';
import { logger } from '../utils/logger';
import { redactSensitiveForLogs } from './privacyService';

export interface UserSessionRecord {
  id: string;
  familyId: string;
  publicKey: string;
  role: string;
  refreshTokenHash: string;
  accessJti: string;
  expiresAt: Date;
  revokedAt?: Date | null;
  replacedBySessionId?: string | null;
}

export interface EncryptedFinancialRecordInput {
  id: string;
  ownerPublicKey: string;
  issuerPublicKey?: string | null;
  attestationId?: string | null;
  recordKind: 'payment' | 'savings' | 'supplementary';
  recordCommitment: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  verified: boolean;
  expiresAt?: Date | null;
}

export interface ConsentGrantInput {
  id: string;
  ownerPublicKey: string;
  granteePublicKey: string;
  scope: string[];
  recordIds: string[];
  expiresAt: Date;
}

export interface IdempotentEntry {
  idempotencyKey: string;
  actorPublicKey: string;
  route: string;
  requestHash: string;
  statusCode: number;
  responseJson: string;
}

export interface StellarTxInput {
  txHash: string;
  operationType: string;
  actorPublicKey: string;
  contractId?: string;
  status: 'pending' | 'confirmed' | 'failed';
  ledgerSequence?: number | null;
  amountStroops?: string;
  metadata?: Record<string, unknown>;
  lastError?: string | null;
}

function useTestMemoryFallback(): boolean {
  return process.env.NODE_ENV === 'test' && !isDatabaseAvailable() && process.env.TEST_REQUIRE_DB !== '1';
}

// Isolated test-only fallback store when Postgres is offline in unit suites
const testMem = {
  users: new Map<string, any>(),
  scores: new Map<string, any>(),
  snapshots: new Map<string, any[]>(),
  loans: new Map<string, any>(),
  vouches: new Map<string, any>(),
  sessions: new Map<string, UserSessionRecord>(),
  encRecords: new Map<string, any>(),
  consents: new Map<string, any>(),
  idempotency: new Map<string, IdempotentEntry>(),
  stellarTxs: new Map<string, any>(),
  lenderPositions: new Map<string, any>(),
  auditLogs: [] as any[],
};

export function resetTestMemoryDb(): void {
  testMem.users.clear();
  testMem.scores.clear();
  testMem.snapshots.clear();
  testMem.loans.clear();
  testMem.vouches.clear();
  testMem.sessions.clear();
  testMem.encRecords.clear();
  testMem.consents.clear();
  testMem.idempotency.clear();
  testMem.stellarTxs.clear();
  testMem.lenderPositions.clear();
  testMem.auditLogs.length = 0;
}

export class DbService {
  async withTransaction<T>(fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return await db.transaction(async (trx) => fn(trx));
  }

  private handleDbError(op: string, error: unknown, strict: boolean): void {
    logger.error(`DbService.${op} error:`, error);
    if (strict && process.env.NODE_ENV === 'production') {
      throw error instanceof Error ? error : new Error(`Database error during ${op}`);
    }
  }

  async upsertUser(publicKey: string, role = 'borrower'): Promise<void> {
    if (useTestMemoryFallback()) {
      const existing = testMem.users.get(publicKey);
      testMem.users.set(publicKey, {
        public_key: publicKey,
        role: existing?.role || role,
        is_active: true,
        created_at: existing?.created_at || new Date(),
        updated_at: new Date(),
      });
      return;
    }
    try {
      await db('users')
        .insert({
          public_key: publicKey,
          role,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .onConflict('public_key')
        .merge({ updated_at: new Date() });
    } catch (error) {
      this.handleDbError('upsertUser', error, true);
    }
  }

  async getUser(publicKey: string): Promise<any> {
    if (useTestMemoryFallback()) {
      return testMem.users.get(publicKey) || null;
    }
    try {
      return await db('users').where({ public_key: publicKey }).first();
    } catch (error) {
      this.handleDbError('getUser', error, false);
      return null;
    }
  }

  // ── Auth Sessions & Refresh Token Families ───────────────────────────────

  async createSession(session: UserSessionRecord): Promise<void> {
    if (useTestMemoryFallback()) {
      testMem.sessions.set(session.refreshTokenHash, { ...session, revokedAt: null });
      return;
    }
    await this.upsertUser(session.publicKey, session.role);
    await db('user_sessions').insert({
      id: session.id,
      family_id: session.familyId,
      public_key: session.publicKey,
      role: session.role,
      refresh_token_hash: session.refreshTokenHash,
      access_jti: session.accessJti,
      expires_at: session.expiresAt,
      revoked_at: null,
      replaced_by_session_id: null,
    });
  }

  async findSessionByRefreshHash(refreshTokenHash: string): Promise<UserSessionRecord | null> {
    if (useTestMemoryFallback()) {
      return testMem.sessions.get(refreshTokenHash) || null;
    }
    const row = await db('user_sessions').where({ refresh_token_hash: refreshTokenHash }).first();
    if (!row) return null;
    return {
      id: row.id,
      familyId: row.family_id,
      publicKey: row.public_key,
      role: row.role,
      refreshTokenHash: row.refresh_token_hash,
      accessJti: row.access_jti,
      expiresAt: new Date(row.expires_at),
      revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
      replacedBySessionId: row.replaced_by_session_id,
    };
  }

  async rotateSession(oldId: string, nextSession: UserSessionRecord): Promise<void> {
    if (useTestMemoryFallback()) {
      for (const s of testMem.sessions.values()) {
        if (s.id === oldId) {
          s.revokedAt = new Date();
          s.replacedBySessionId = nextSession.id;
        }
      }
      testMem.sessions.set(nextSession.refreshTokenHash, { ...nextSession, revokedAt: null });
      return;
    }
    await this.withTransaction(async (trx) => {
      await trx('user_sessions').where({ id: oldId }).update({
        revoked_at: new Date(),
        replaced_by_session_id: nextSession.id,
      });
      await trx('user_sessions').insert({
        id: nextSession.id,
        family_id: nextSession.familyId,
        public_key: nextSession.publicKey,
        role: nextSession.role,
        refresh_token_hash: nextSession.refreshTokenHash,
        access_jti: nextSession.accessJti,
        expires_at: nextSession.expiresAt,
        revoked_at: null,
        replaced_by_session_id: null,
      });
    });
  }

  async revokeSessionFamily(familyId: string): Promise<string[]> {
    if (useTestMemoryFallback()) {
      const revokedJtis: string[] = [];
      for (const s of testMem.sessions.values()) {
        if (s.familyId === familyId) {
          s.revokedAt = new Date();
          revokedJtis.push(s.accessJti);
        }
      }
      return revokedJtis;
    }
    const rows = await db('user_sessions')
      .where({ family_id: familyId })
      .whereNull('revoked_at')
      .select('access_jti');
    await db('user_sessions')
      .where({ family_id: familyId })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date() });
    return rows.map((r: any) => r.access_jti).filter(Boolean);
  }

  async revokeUserSessions(publicKey: string): Promise<string[]> {
    if (useTestMemoryFallback()) {
      const revokedJtis: string[] = [];
      for (const s of testMem.sessions.values()) {
        if (s.publicKey === publicKey && !s.revokedAt) {
          s.revokedAt = new Date();
          revokedJtis.push(s.accessJti);
        }
      }
      return revokedJtis;
    }
    const rows = await db('user_sessions')
      .where({ public_key: publicKey })
      .whereNull('revoked_at')
      .select('access_jti');
    await db('user_sessions')
      .where({ public_key: publicKey })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date() });
    return rows.map((r: any) => r.access_jti).filter(Boolean);
  }

  // ── Credit Score Cache & Real History Snapshots ──────────────────────────

  async upsertCreditScore(data: {
    publicKey: string;
    score: number;
    paymentHistoryScore?: number;
    savingsScore?: number;
    repaymentScore?: number;
    communityScore?: number;
    activityScore?: number;
    modelVersion?: number;
  }): Promise<void> {
    if (useTestMemoryFallback()) {
      testMem.scores.set(data.publicKey, {
        public_key: data.publicKey,
        score: data.score,
        payment_history_score: data.paymentHistoryScore ?? 0,
        savings_score: data.savingsScore ?? 0,
        repayment_score: data.repaymentScore ?? 0,
        community_score: data.communityScore ?? 0,
        activity_score: data.activityScore ?? 0,
        model_version: data.modelVersion ?? 2,
        last_updated: new Date(),
      });
      const list = testMem.snapshots.get(data.publicKey) || [];
      list.push({
        public_key: data.publicKey,
        model_version: data.modelVersion ?? 2,
        score: data.score,
        payment_history_score: data.paymentHistoryScore ?? 0,
        savings_score: data.savingsScore ?? 0,
        repayment_score: data.repaymentScore ?? 0,
        community_score: data.communityScore ?? 0,
        activity_score: data.activityScore ?? 0,
        recorded_at: new Date(),
      });
      testMem.snapshots.set(data.publicKey, list);
      return;
    }
    try {
      await this.upsertUser(data.publicKey);
      await this.withTransaction(async (trx) => {
        await trx('credit_score_cache')
          .insert({
            public_key: data.publicKey,
            score: data.score,
            payment_history_score: data.paymentHistoryScore ?? 0,
            savings_score: data.savingsScore ?? 0,
            repayment_score: data.repaymentScore ?? 0,
            community_score: data.communityScore ?? 0,
            activity_score: data.activityScore ?? 0,
            model_version: data.modelVersion ?? 2,
            last_updated: new Date(),
          })
          .onConflict('public_key')
          .merge({
            score: data.score,
            payment_history_score: data.paymentHistoryScore ?? 0,
            savings_score: data.savingsScore ?? 0,
            repayment_score: data.repaymentScore ?? 0,
            community_score: data.communityScore ?? 0,
            activity_score: data.activityScore ?? 0,
            model_version: data.modelVersion ?? 2,
            last_updated: new Date(),
          });

        await trx('score_snapshots').insert({
          public_key: data.publicKey,
          model_version: data.modelVersion ?? 2,
          score: data.score,
          payment_history_score: data.paymentHistoryScore ?? 0,
          savings_score: data.savingsScore ?? 0,
          repayment_score: data.repaymentScore ?? 0,
          community_score: data.communityScore ?? 0,
          activity_score: data.activityScore ?? 0,
          recorded_at: new Date(),
        });
      });
    } catch (error) {
      this.handleDbError('upsertCreditScore', error, false);
    }
  }

  async getCachedCreditScore(publicKey: string): Promise<any> {
    if (useTestMemoryFallback()) {
      return testMem.scores.get(publicKey) || null;
    }
    try {
      return await db('credit_score_cache').where({ public_key: publicKey }).first();
    } catch (error) {
      this.handleDbError('getCachedCreditScore', error, false);
      return null;
    }
  }

  async getScoreHistory(publicKey: string, limit = 30): Promise<any[]> {
    if (useTestMemoryFallback()) {
      const list = testMem.snapshots.get(publicKey) || [];
      return list.slice(-limit);
    }
    try {
      return await db('score_snapshots')
        .where({ public_key: publicKey })
        .orderBy('recorded_at', 'desc')
        .limit(limit);
    } catch (error) {
      this.handleDbError('getScoreHistory', error, false);
      return [];
    }
  }

  // ── Encrypted Financial Records & Consent Grants ─────────────────────────

  async storeEncryptedRecord(rec: EncryptedFinancialRecordInput): Promise<void> {
    if (useTestMemoryFallback()) {
      testMem.encRecords.set(rec.id, {
        id: rec.id,
        owner_public_key: rec.ownerPublicKey,
        issuer_public_key: rec.issuerPublicKey || null,
        attestation_id: rec.attestationId || null,
        record_kind: rec.recordKind,
        record_commitment: rec.recordCommitment,
        ciphertext: rec.ciphertext,
        iv: rec.iv,
        auth_tag: rec.authTag,
        verified: rec.verified,
        expires_at: rec.expiresAt || null,
        deleted_at: null,
        created_at: new Date(),
      });
      return;
    }
    await this.upsertUser(rec.ownerPublicKey);
    await db('encrypted_financial_records').insert({
      id: rec.id,
      owner_public_key: rec.ownerPublicKey,
      issuer_public_key: rec.issuerPublicKey || null,
      attestation_id: rec.attestationId || null,
      record_kind: rec.recordKind,
      record_commitment: rec.recordCommitment,
      ciphertext: rec.ciphertext,
      iv: rec.iv,
      auth_tag: rec.authTag,
      verified: rec.verified,
      expires_at: rec.expiresAt || null,
      deleted_at: null,
    });
  }

  async getOwnerEncryptedRecords(
    ownerPublicKey: string,
    recordIds?: string[]
  ): Promise<any[]> {
    if (useTestMemoryFallback()) {
      return Array.from(testMem.encRecords.values()).filter(
        (r) =>
          r.owner_public_key === ownerPublicKey &&
          !r.deleted_at &&
          (!recordIds || recordIds.length === 0 || recordIds.includes(r.id))
      );
    }
    let query = db('encrypted_financial_records')
      .where({ owner_public_key: ownerPublicKey })
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc');
    if (recordIds && recordIds.length > 0) {
      query = query.whereIn('id', recordIds);
    }
    return await query;
  }

  async deleteOwnerPrivateRecords(ownerPublicKey: string): Promise<number> {
    if (useTestMemoryFallback()) {
      let count = 0;
      for (const [id, rec] of testMem.encRecords.entries()) {
        if (rec.owner_public_key === ownerPublicKey && !rec.deleted_at) {
          rec.deleted_at = new Date();
          rec.ciphertext = 'DELETED';
          testMem.encRecords.set(id, rec);
          count++;
        }
      }
      return count;
    }
    return await db('encrypted_financial_records')
      .where({ owner_public_key: ownerPublicKey })
      .whereNull('deleted_at')
      .update({ deleted_at: new Date(), ciphertext: 'DELETED' });
  }

  async createConsentGrant(grant: ConsentGrantInput): Promise<void> {
    if (useTestMemoryFallback()) {
      testMem.consents.set(grant.id, {
        id: grant.id,
        owner_public_key: grant.ownerPublicKey,
        grantee_public_key: grant.granteePublicKey,
        scope_json: JSON.stringify(grant.scope),
        record_ids_json: JSON.stringify(grant.recordIds),
        expires_at: grant.expiresAt,
        revoked_at: null,
        created_at: new Date(),
      });
      return;
    }
    await this.upsertUser(grant.ownerPublicKey);
    await db('consent_grants').insert({
      id: grant.id,
      owner_public_key: grant.ownerPublicKey,
      grantee_public_key: grant.granteePublicKey,
      scope_json: JSON.stringify(grant.scope),
      record_ids_json: JSON.stringify(grant.recordIds),
      expires_at: grant.expiresAt,
      revoked_at: null,
    });
  }

  async getConsentGrant(grantId: string): Promise<any | null> {
    if (useTestMemoryFallback()) {
      return testMem.consents.get(grantId) || null;
    }
    return await db('consent_grants').where({ id: grantId }).first();
  }

  async revokeConsentGrant(grantId: string, ownerPublicKey: string): Promise<boolean> {
    if (useTestMemoryFallback()) {
      const g = testMem.consents.get(grantId);
      if (!g || g.owner_public_key !== ownerPublicKey || g.revoked_at) return false;
      g.revoked_at = new Date();
      return true;
    }
    const updated = await db('consent_grants')
      .where({ id: grantId, owner_public_key: ownerPublicKey })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date() });
    return updated > 0;
  }

  // ── Loans & Vouches & Lender Positions ────────────────────────────────────

  async upsertLoan(loan: {
    id: number | string;
    borrowerPublicKey: string;
    amount: string | number;
    interestRate: number;
    durationMonths: number;
    status?: string;
    creditScoreUsed?: number;
    repaidAmount?: string | number;
    principalRepaid?: string | number;
    interestRepaid?: string | number;
    scheduledInterest?: string | number;
    collateralAmount?: string | number;
    collateralLocked?: boolean;
    txHash?: string;
    dueDate?: Date | null;
  }): Promise<void> {
    if (useTestMemoryFallback()) {
      testMem.loans.set(String(loan.id), {
        id: loan.id,
        borrower_public_key: loan.borrowerPublicKey,
        amount: String(loan.amount),
        interest_rate: loan.interestRate,
        duration_months: loan.durationMonths,
        status: loan.status || 'pending',
        credit_score_used: loan.creditScoreUsed || 0,
        repaid_amount: String(loan.repaidAmount ?? 0),
        principal_repaid: String(loan.principalRepaid ?? 0),
        interest_repaid: String(loan.interestRepaid ?? 0),
        scheduled_interest: String(loan.scheduledInterest ?? 0),
        collateral_amount: String(loan.collateralAmount ?? 0),
        collateral_locked: Boolean(loan.collateralLocked),
        tx_hash: loan.txHash || null,
        due_date: loan.dueDate || null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      return;
    }
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
          repaid_amount: loan.repaidAmount ?? 0,
          principal_repaid: String(loan.principalRepaid ?? 0),
          interest_repaid: String(loan.interestRepaid ?? 0),
          scheduled_interest: String(loan.scheduledInterest ?? 0),
          collateral_amount: String(loan.collateralAmount ?? 0),
          collateral_locked: Boolean(loan.collateralLocked),
          tx_hash: loan.txHash || null,
          due_date: loan.dueDate || null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .onConflict('id')
        .merge({
          status: loan.status || 'pending',
          repaid_amount: loan.repaidAmount ?? 0,
          principal_repaid: String(loan.principalRepaid ?? 0),
          interest_repaid: String(loan.interestRepaid ?? 0),
          collateral_locked: Boolean(loan.collateralLocked),
          tx_hash: loan.txHash || null,
          updated_at: new Date(),
        });
    } catch (error) {
      this.handleDbError('upsertLoan', error, true);
    }
  }

  async getLoanById(loanId: number | string): Promise<any> {
    if (useTestMemoryFallback()) {
      return testMem.loans.get(String(loanId)) || null;
    }
    try {
      return await db('loans').where({ id: loanId }).first();
    } catch (error) {
      this.handleDbError('getLoanById', error, false);
      return null;
    }
  }

  async getUserLoans(publicKey: string, status?: string): Promise<any[]> {
    if (useTestMemoryFallback()) {
      return Array.from(testMem.loans.values()).filter(
        (l) => l.borrower_public_key === publicKey && (!status || status === 'all' || l.status === status)
      );
    }
    try {
      let query = db('loans').where({ borrower_public_key: publicKey }).orderBy('created_at', 'desc');
      if (status && status !== 'all') {
        query = query.where({ status });
      }
      return await query;
    } catch (error) {
      this.handleDbError('getUserLoans', error, false);
      return [];
    }
  }

  async getActiveLoans(): Promise<any[]> {
    if (useTestMemoryFallback()) {
      return Array.from(testMem.loans.values()).filter(
        (l) => l.status === 'pending' || l.status === 'active'
      );
    }
    try {
      return await db('loans').whereIn('status', ['pending', 'active']).orderBy('created_at', 'desc');
    } catch (error) {
      this.handleDbError('getActiveLoans', error, false);
      return [];
    }
  }

  async updateLoanStatus(
    loanId: number | string,
    status: string,
    repaidAmount?: string | number,
    collateralLocked?: boolean
  ): Promise<void> {
    if (useTestMemoryFallback()) {
      const existing = testMem.loans.get(String(loanId));
      if (existing) {
        existing.status = status;
        if (repaidAmount !== undefined) existing.repaid_amount = String(repaidAmount);
        if (collateralLocked !== undefined) existing.collateral_locked = collateralLocked;
        existing.updated_at = new Date();
      }
      return;
    }
    try {
      const updateData: Record<string, unknown> = { status, updated_at: new Date() };
      if (repaidAmount !== undefined) updateData.repaid_amount = repaidAmount;
      if (collateralLocked !== undefined) updateData.collateral_locked = collateralLocked;
      await db('loans').where({ id: loanId }).update(updateData);
    } catch (error) {
      this.handleDbError('updateLoanStatus', error, true);
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
    escrowedBalance?: string | number;
    slashedAmount?: string | number;
    withdrawn?: boolean;
    txHash?: string;
    expirationDate?: Date | null;
  }): Promise<void> {
    if (useTestMemoryFallback()) {
      testMem.vouches.set(String(vouch.id), {
        id: vouch.id,
        voucher_key: vouch.voucherKey,
        vouchee_key: vouch.voucheeKey,
        amount: String(vouch.amount),
        escrowed_balance: String(vouch.escrowedBalance ?? vouch.amount),
        slashed_amount: String(vouch.slashedAmount ?? 0),
        trust_score: vouch.trustScore,
        reason: vouch.reason || null,
        is_active: vouch.isActive ?? true,
        withdrawn: Boolean(vouch.withdrawn),
        tx_hash: vouch.txHash || null,
        expiration_date: vouch.expirationDate || null,
        created_at: new Date(),
      });
      return;
    }
    try {
      await this.upsertUser(vouch.voucherKey);
      await this.upsertUser(vouch.voucheeKey);
      await db('vouches')
        .insert({
          id: vouch.id,
          voucher_key: vouch.voucherKey,
          vouchee_key: vouch.voucheeKey,
          amount: vouch.amount,
          escrowed_balance: String(vouch.escrowedBalance ?? vouch.amount),
          slashed_amount: String(vouch.slashedAmount ?? 0),
          trust_score: vouch.trustScore,
          reason: vouch.reason || null,
          is_active: vouch.isActive ?? true,
          withdrawn: Boolean(vouch.withdrawn),
          tx_hash: vouch.txHash || null,
          expiration_date: vouch.expirationDate || null,
          created_at: new Date(),
        })
        .onConflict('id')
        .merge({
          is_active: vouch.isActive ?? true,
          escrowed_balance: String(vouch.escrowedBalance ?? 0),
          withdrawn: Boolean(vouch.withdrawn),
        });
    } catch (error) {
      this.handleDbError('upsertVouch', error, true);
    }
  }

  async getUserVouches(publicKey: string): Promise<any[]> {
    if (useTestMemoryFallback()) {
      return Array.from(testMem.vouches.values()).filter(
        (v) => v.voucher_key === publicKey || v.vouchee_key === publicKey
      );
    }
    try {
      return await db('vouches')
        .where({ voucher_key: publicKey })
        .orWhere({ vouchee_key: publicKey })
        .orderBy('created_at', 'desc');
    } catch (error) {
      this.handleDbError('getUserVouches', error, false);
      return [];
    }
  }

  async updateVouchStatus(vouchId: number | string, isActive: boolean, withdrawn = !isActive): Promise<void> {
    if (useTestMemoryFallback()) {
      const existing = testMem.vouches.get(String(vouchId));
      if (existing) {
        existing.is_active = isActive;
        existing.withdrawn = withdrawn;
        if (!isActive) existing.escrowed_balance = '0';
      }
      return;
    }
    try {
      await db('vouches')
        .where({ id: vouchId })
        .update({
          is_active: isActive,
          withdrawn,
          escrowed_balance: isActive ? undefined : '0',
        });
    } catch (error) {
      this.handleDbError('updateVouchStatus', error, true);
    }
  }

  // ── Idempotency, Tx Reconciliation & Audit Logs ──────────────────────────

  async getIdempotentResponse(
    actorPublicKey: string,
    route: string,
    idempotencyKey: string
  ): Promise<IdempotentEntry | null> {
    const k = `${actorPublicKey}:${route}:${idempotencyKey}`;
    if (useTestMemoryFallback()) {
      return testMem.idempotency.get(k) || null;
    }
    const row = await db('idempotency_keys')
      .where({ actor_public_key: actorPublicKey, route, idempotency_key: idempotencyKey })
      .where('expires_at', '>', new Date())
      .first();
    if (!row) return null;
    return {
      idempotencyKey: row.idempotency_key,
      actorPublicKey: row.actor_public_key,
      route: row.route,
      requestHash: row.request_hash,
      statusCode: row.status_code,
      responseJson: row.response_json,
    };
  }

  async saveIdempotentResponse(entry: IdempotentEntry): Promise<void> {
    const k = `${entry.actorPublicKey}:${entry.route}:${entry.idempotencyKey}`;
    if (useTestMemoryFallback()) {
      testMem.idempotency.set(k, entry);
      return;
    }
    try {
      await db('idempotency_keys')
        .insert({
          idempotency_key: entry.idempotencyKey,
          actor_public_key: entry.actorPublicKey,
          route: entry.route,
          request_hash: entry.requestHash,
          status_code: entry.statusCode,
          response_json: entry.responseJson,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        })
        .onConflict(['actor_public_key', 'route', 'idempotency_key'])
        .ignore();
    } catch (error) {
      this.handleDbError('saveIdempotentResponse', error, false);
    }
  }

  async recordStellarTx(tx: StellarTxInput): Promise<void> {
    if (useTestMemoryFallback()) {
      testMem.stellarTxs.set(tx.txHash, {
        tx_hash: tx.txHash,
        operation_type: tx.operationType,
        actor_public_key: tx.actorPublicKey,
        contract_id: tx.contractId || null,
        status: tx.status,
        ledger_sequence: tx.ledgerSequence ?? null,
        amount_stroops: tx.amountStroops || '0',
        metadata_json: tx.metadata ? JSON.stringify(tx.metadata) : null,
        retry_count: 0,
        last_error: tx.lastError || null,
        reconciled_at: tx.status === 'confirmed' ? new Date() : null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      return;
    }
    await db('stellar_transactions')
      .insert({
        tx_hash: tx.txHash,
        operation_type: tx.operationType,
        actor_public_key: tx.actorPublicKey,
        contract_id: tx.contractId || null,
        status: tx.status,
        ledger_sequence: tx.ledgerSequence ?? null,
        amount_stroops: tx.amountStroops || '0',
        metadata_json: tx.metadata ? JSON.stringify(tx.metadata) : null,
        last_error: tx.lastError || null,
        reconciled_at: tx.status === 'confirmed' ? new Date() : null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict('tx_hash')
      .merge({
        status: tx.status,
        ledger_sequence: tx.ledgerSequence ?? null,
        last_error: tx.lastError || null,
        reconciled_at: tx.status === 'confirmed' ? new Date() : null,
        updated_at: new Date(),
      });
  }

  async getPendingStellarTxs(limit = 20): Promise<any[]> {
    if (useTestMemoryFallback()) {
      return Array.from(testMem.stellarTxs.values())
        .filter((t) => t.status === 'pending' && t.retry_count < 10)
        .slice(0, limit);
    }
    return await db('stellar_transactions')
      .where({ status: 'pending' })
      .where('retry_count', '<', 10)
      .orderBy('created_at', 'asc')
      .limit(limit);
  }

  async updateStellarTxReconciliation(
    txHash: string,
    status: 'pending' | 'confirmed' | 'failed',
    ledgerSequence?: number | null,
    lastError?: string | null
  ): Promise<void> {
    if (useTestMemoryFallback()) {
      const existing = testMem.stellarTxs.get(txHash);
      if (existing) {
        existing.status = status;
        if (ledgerSequence !== undefined) existing.ledger_sequence = ledgerSequence;
        if (lastError !== undefined) existing.last_error = lastError;
        if (status === 'pending') existing.retry_count += 1;
        if (status === 'confirmed') existing.reconciled_at = new Date();
        existing.updated_at = new Date();
      }
      return;
    }
    const update: Record<string, unknown> = {
      status,
      updated_at: new Date(),
    };
    if (ledgerSequence !== undefined) update.ledger_sequence = ledgerSequence;
    if (lastError !== undefined) update.last_error = lastError;
    if (status === 'confirmed') update.reconciled_at = new Date();
    if (status === 'pending') {
      await db('stellar_transactions').where({ tx_hash: txHash }).increment('retry_count', 1).update(update);
    } else {
      await db('stellar_transactions').where({ tx_hash: txHash }).update(update);
    }
  }

  async getStellarTx(txHash: string): Promise<any | null> {
    if (useTestMemoryFallback()) {
      return testMem.stellarTxs.get(txHash) || null;
    }
    return await db('stellar_transactions').where({ tx_hash: txHash }).first();
  }

  async recordAuditLog(entry: {
    actorPublicKey?: string;
    action: string;
    resourceType?: string;
    resourceId?: string;
    status: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    const cleanDetails = entry.details ? redactSensitiveForLogs(entry.details) : null;
    if (useTestMemoryFallback()) {
      testMem.auditLogs.push({
        actor_public_key: entry.actorPublicKey || null,
        action: entry.action,
        resource_type: entry.resourceType || null,
        resource_id: entry.resourceId || null,
        status: entry.status,
        details_json: cleanDetails ? JSON.stringify(cleanDetails) : null,
        created_at: new Date(),
      });
      return;
    }
    try {
      await db('audit_logs').insert({
        actor_public_key: entry.actorPublicKey || null,
        action: entry.action,
        resource_type: entry.resourceType || null,
        resource_id: entry.resourceId || null,
        status: entry.status,
        details_json: cleanDetails ? JSON.stringify(cleanDetails) : null,
      });
    } catch (error) {
      this.handleDbError('recordAuditLog', error, false);
    }
  }
}

export const dbService = new DbService();
