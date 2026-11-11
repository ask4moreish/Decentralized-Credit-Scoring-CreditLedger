import crypto from 'node:crypto';
import {
  canonicalJson,
  computeRecordCommitment,
  decryptFinancialRecord,
  encryptFinancialRecord,
  filterDisclosedClaims,
  redactSensitiveForLogs,
  resolveEncryptionKey,
} from '../services/privacyService';

describe('Privacy Service (AES-256-GCM, Commitments, Selective Disclosure & Redaction)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('canonicalJson sorts keys deterministically and commitment binds field order independently', () => {
    const a = { monthlyIncome: 4200, accountNumber: 'ACCT-9988', paidOnTime: true };
    const b = { paidOnTime: true, accountNumber: 'ACCT-9988', monthlyIncome: 4200 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(computeRecordCommitment(a)).toBe(computeRecordCommitment(b));
    expect(computeRecordCommitment({ ...a, monthlyIncome: 4201 })).not.toBe(
      computeRecordCommitment(a)
    );
  });

  test('encrypts with AES-256-GCM and fails closed if ciphertext or authTag is tampered', () => {
    const key = crypto.randomBytes(32);
    const payload = { monthlyIncome: 5000, onTimeRatio: 98, ssn: '123-45-6789' };
    const encrypted = encryptFinancialRecord(payload, key);

    const roundTrip = decryptFinancialRecord(encrypted, key);
    expect(roundTrip).toEqual(payload);

    // Flip last hex nibble of authTag to verify GCM authentication tag enforcement
    const tamperedTag =
      encrypted.authTag.slice(0, -1) + (encrypted.authTag.endsWith('a') ? 'b' : 'a');
    expect(() =>
      decryptFinancialRecord({ ...encrypted, authTag: tamperedTag }, key)
    ).toThrow();
  });

  test('requires explicit DATA_ENCRYPTION_KEY in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DATA_ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    expect(() => resolveEncryptionKey()).toThrow(/DATA_ENCRYPTION_KEY/);

    process.env.DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    expect(resolveEncryptionKey().length).toBe(32);
  });

  test('selective disclosure strips forbidden PII fields even if explicitly requested', () => {
    const record = {
      monthlyIncome: 6500,
      onTimeStreak: 18,
      accountNumber: 'SECRET-123',
      ssn: '999-00-1111',
      email: 'alice@example.com',
      fullName: 'Alice Example',
    };
    const commitment = computeRecordCommitment(record);
    const disclosed = filterDisclosedClaims(
      record,
      ['monthlyIncome', 'accountNumber', 'ssn', 'email', 'fullName', 'onTimeStreak'],
      commitment
    );

    expect(disclosed.recordCommitment).toBe(commitment);
    expect(disclosed.disclosedClaims).toEqual({
      monthlyIncome: 6500,
      onTimeStreak: 18,
    });
    expect(disclosed.disclosedKeys).toEqual(['monthlyIncome', 'onTimeStreak']);
  });

  test('redacts Stellar secret seeds, Bearer JWTs, and sensitive JSON keys', () => {
    const fakeSeed = 'S' + 'A'.repeat(55);
    const fakeJwt = 'Bearer aaa.bbb.ccc';
    const cleaned = redactSensitiveForLogs({
      message: `Leak ${fakeSeed} with ${fakeJwt}`,
      password: 'top-secret-password',
      signedXdr: 'AAAA...',
      nested: { refreshToken: 'tok-123', safeNote: 'loan-approved' },
    }) as Record<string, any>;

    expect(cleaned.message).toContain('[REDACTED_STELLAR_SEED]');
    expect(cleaned.message).toContain('Bearer [REDACTED_JWT]');
    expect(cleaned.password).toBe('[REDACTED]');
    expect(cleaned.signedXdr).toBe('[REDACTED]');
    expect(cleaned.nested.refreshToken).toBe('[REDACTED]');
    expect(cleaned.nested.safeNote).toBe('loan-approved');
  });
});
