export const STELLAR_NETWORK = import.meta.env.VITE_STELLAR_NETWORK || 'testnet';
export const STELLAR_HORIZON_URL =
  import.meta.env.VITE_STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export const ALLOWED_NETWORK = STELLAR_NETWORK;

export const NETWORK_PASSPHRASE =
  STELLAR_NETWORK === 'mainnet'
    ? 'Public Global Stellar Network ; September 2015'
    : 'Test SDF Network ; September 2015';
