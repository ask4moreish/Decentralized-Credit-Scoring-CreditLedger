import { describe, it, expect } from 'vitest';
import { STELLAR_CONFIG, formatStroops, getTxExplorerUrl } from '../config/stellar';

describe('Frontend Stellar Configuration & Stroop Formatting', () => {
  it('configures default Testnet network & contracts cleanly', () => {
    expect(STELLAR_CONFIG.network).toBe('testnet');
    expect(STELLAR_CONFIG.networkPassphrase).toBe('Test SDF Network ; September 2015');
    expect(STELLAR_CONFIG.contracts.creditScore).toMatch(/^C[A-Z2-7]{55}$/);
    expect(STELLAR_CONFIG.contracts.loanManager).toMatch(/^C[A-Z2-7]{55}$/);
    expect(STELLAR_CONFIG.contracts.communityVouch).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it('formats 7-decimal stroops accurately without float drift', () => {
    expect(formatStroops('10000000')).toBe('1');
    expect(formatStroops('1550000000')).toBe('155');
    expect(formatStroops('10500000')).toBe('1.05');
    expect(formatStroops('1')).toBe('0.0000001');
    expect(formatStroops(undefined)).toBe('0');
  });

  it('builds safe Stellar Expert transaction links', () => {
    expect(getTxExplorerUrl('abc123')).toContain('/tx/abc123');
  });
});
