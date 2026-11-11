import {
  parseDecimalToStroops,
  parseNonNegativeStroops,
  parseRawU128String,
  formatStroopsToDecimal,
} from '../utils/amounts';

describe('Financial Amounts & 7-Decimal Stroop Arithmetic', () => {
  test('parses whole and decimal strings into exact 7-decimal stroops', () => {
    expect(parseDecimalToStroops('1')).toBe('10000000');
    expect(parseDecimalToStroops('100.5')).toBe('1005000000');
    expect(parseDecimalToStroops('0.0000001')).toBe('1');
    expect(parseDecimalToStroops(250)).toBe('2500000000');
  });

  test('rejects zero, negative, scientific notation, and excess decimals', () => {
    expect(() => parseDecimalToStroops('0')).toThrow();
    expect(() => parseDecimalToStroops('-10')).toThrow();
    expect(() => parseDecimalToStroops('1e5')).toThrow();
    expect(() => parseDecimalToStroops('1.00000001')).toThrow();
    expect(() => parseDecimalToStroops('abc')).toThrow();
  });

  test('handles optional non-negative collateral and raw u128 strings safely', () => {
    expect(parseNonNegativeStroops(undefined)).toBe('0');
    expect(parseNonNegativeStroops('')).toBe('0');
    expect(parseNonNegativeStroops('0')).toBe('0');
    expect(parseNonNegativeStroops('50.25')).toBe('502500000');
    expect(parseRawU128String('000420000000')).toBe('420000000');
    expect(() => parseRawU128String('-5')).toThrow();
  });

  test('formats stroop integers back into readable decimal strings', () => {
    expect(formatStroopsToDecimal('10000000')).toBe('1');
    expect(formatStroopsToDecimal('1005000000')).toBe('100.5');
    expect(formatStroopsToDecimal('1')).toBe('0.0000001');
    expect(formatStroopsToDecimal('0')).toBe('0');
  });
});
