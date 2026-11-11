const STROOPS_PER_UNIT = 10_000_000n;
const DECIMALS = 7;

/**
 * Parses a decimal string or integer number into exact integer base units (stroops, 7 decimals).
 * Throws on negative values, NaN, scientific notation, or > 7 fractional digits.
 */
export function parseDecimalToStroops(value: string | number): string {
  const raw = typeof value === 'number' ? value.toString() : String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid positive financial amount: "${raw}"`);
  }
  const [whole, frac = ''] = raw.split('.');
  if (frac.length > DECIMALS) {
    throw new Error(`Amount "${raw}" exceeds maximum precision of ${DECIMALS} decimal places`);
  }
  const paddedFrac = frac.padEnd(DECIMALS, '0');
  const stroops = BigInt(whole) * STROOPS_PER_UNIT + BigInt(paddedFrac || '0');
  if (stroops <= 0n) {
    throw new Error('Financial amount must be strictly positive');
  }
  return stroops.toString();
}

export function parseNonNegativeStroops(value: string | number | undefined): string {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') {
    return '0';
  }
  return parseDecimalToStroops(value);
}

/**
 * Parses an already-integer base unit string (e.g. raw u128 ledger stroops) safely.
 */
export function parseRawU128String(value: string | number | bigint): string {
  const s = typeof value === 'bigint' ? value.toString() : String(value).trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`Invalid integer u128 amount: "${s}"`);
  }
  return BigInt(s).toString();
}

export function formatStroopsToDecimal(stroops: string | number | bigint): string {
  const val = BigInt(typeof stroops === 'string' ? stroops.trim() || '0' : stroops);
  const sign = val < 0n ? '-' : '';
  const abs = val < 0n ? -val : val;
  const whole = abs / STROOPS_PER_UNIT;
  const frac = (abs % STROOPS_PER_UNIT).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}
