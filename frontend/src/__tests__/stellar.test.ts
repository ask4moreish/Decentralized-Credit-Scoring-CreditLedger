import { STELLAR_NETWORK, NETWORK_PASSPHRASE, ALLOWED_NETWORK } from '../config/stellar';

describe('stellar config', () => {
  it('defaults to testnet', () => {
    expect(STELLAR_NETWORK).toBe('testnet');
  });

  it('ALLOWED_NETWORK matches STELLAR_NETWORK', () => {
    expect(ALLOWED_NETWORK).toBe(STELLAR_NETWORK);
  });

  it('uses testnet passphrase for non-mainnet', () => {
    expect(NETWORK_PASSPHRASE).toBe('Test SDF Network ; September 2015');
  });
});
