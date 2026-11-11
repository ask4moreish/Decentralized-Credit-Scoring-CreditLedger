import crypto from 'node:crypto';

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

const EPHEMERAL_NON_PROD_KEY = crypto.randomBytes(32);

export function resolveEncryptionKey(): Buffer {
  const configured = process.env.DATA_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || '';
  if (configured) {
    if (/^[0-9a-fA-F]{64}$/.test(configured)) {
      return Buffer.from(configured, 'hex');
    }
    const raw = Buffer.from(configured, 'base64');
    if (raw.length === 32) {
      return raw;
    }
    if (configured.length >= 32) {
      return crypto.createHash('sha256').update(configured).digest();
    }
    throw new Error('DATA_ENCRYPTION_KEY must be at least 32 characters or 64 hex chars');
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATA_ENCRYPTION_KEY must be explicitly configured in production');
  }

  return EPHEMERAL_NON_PROD_KEY;
}

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number rejected in canonical JSON');
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`Unsupported canonical JSON value type: ${typeof value}`);
}

export function computeRecordCommitment(record: Record<string, unknown>): string {
  const payload = canonicalJson(record);
  return crypto
    .createHash('sha256')
    .update('CREDITLEDGER-RECORD-V1:')
    .update(payload)
    .digest('hex');
}

export function encryptFinancialRecord(
  record: Record<string, unknown>,
  keyOverride?: Buffer
): EncryptedPayload {
  const key = keyOverride ?? resolveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(canonicalJson(record), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

export function decryptFinancialRecord(
  payload: EncryptedPayload,
  keyOverride?: Buffer
): Record<string, unknown> {
  const key = keyOverride ?? resolveEncryptionKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(payload.iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8')) as Record<string, unknown>;
}

const FORBIDDEN_DISCLOSURE_FIELDS = new Set([
  'accountNumber',
  'iban',
  'ssn',
  'nationalId',
  'phoneNumber',
  'email',
  'fullName',
  'address',
  'rawStatement',
]);

export function filterDisclosedClaims(
  record: Record<string, unknown>,
  allowedFields: string[],
  recordCommitment: string
): Record<string, unknown> {
  const claims: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (FORBIDDEN_DISCLOSURE_FIELDS.has(field)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      claims[field] = record[field];
    }
  }
  return {
    recordCommitment,
    disclosedClaims: claims,
    disclosedKeys: Object.keys(claims).sort(),
  };
}

const SENSITIVE_KEY_PATTERN =
  /^(authorization|cookie|set-cookie|password|secret|jwt|token|refreshtoken|privatekey|secretkey|adminsecret|signedxdr|ciphertext|accountnumber|phonenumber|nationalid|ssn|email)$/i;

export function redactSensitiveForLogs(input: unknown, depth = 0): unknown {
  if (depth > 5) return '[MAX_DEPTH]';
  if (typeof input === 'string') {
    let sanitized = input.replace(/\bS[A-Z2-7]{55}\b/g, '[REDACTED_STELLAR_SEED]');
    sanitized = sanitized.replace(
      /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/gi,
      'Bearer [REDACTED_JWT]'
    );
    return sanitized;
  }
  if (input === null || typeof input !== 'object') {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveForLogs(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactSensitiveForLogs(v, depth + 1);
    }
  }
  return out;
}
