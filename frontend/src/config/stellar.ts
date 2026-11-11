export const STELLAR_CONFIG = {
  apiUrl: import.meta.env.VITE_API_URL || 'http://localhost:3001/api',
  network: (import.meta.env.VITE_STELLAR_NETWORK || 'testnet') as 'testnet' | 'mainnet',
  networkPassphrase:
    import.meta.env.VITE_STELLAR_NETWORK === 'mainnet'
      ? 'Public Global Stellar Network ; September 2015'
      : 'Test SDF Network ; September 2015',
  horizonUrl: import.meta.env.VITE_STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
  rpcUrl: import.meta.env.VITE_STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  explorerUrl:
    import.meta.env.VITE_STELLAR_EXPLORER_URL || 'https://stellar.expert/explorer/testnet',
  contracts: {
    creditScore:
      import.meta.env.VITE_CREDIT_SCORE_CONTRACT ||
      'CAAPEEPQJH5ZQHOYOF3KVHQNUGZV5DVPUSE4KCAKJ3E3NQGEYQ53ZUTW',
    loanManager:
      import.meta.env.VITE_LOAN_MANAGER_CONTRACT ||
      'CB4KYCG62B62RNMIGHV2NP5GDCGPGE23XW5FQVOTBE266PFPKKB5NNXB',
    communityVouch:
      import.meta.env.VITE_COMMUNITY_VOUCH_CONTRACT ||
      'CAQSXBETHWHNXF5BJV37CVD2AI4D4JTVZ3J2S3YLTAPUF5V7BWFV444F',
    loanToken:
      import.meta.env.VITE_LOAN_TOKEN_CONTRACT ||
      'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  },
};

export function formatStroops(stroops: string | number | bigint | undefined): string {
  if (stroops === undefined || stroops === null || stroops === '') return '0';
  const raw = String(stroops).trim();
  if (!/^-?\d+$/.test(raw)) return raw;
  const val = BigInt(raw);
  const sign = val < 0n ? '-' : '';
  const abs = val < 0n ? -val : val;
  const whole = abs / 10_000_000n;
  const frac = (abs % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

export function getTxExplorerUrl(txHash: string): string {
  return `${STELLAR_CONFIG.explorerUrl}/tx/${encodeURIComponent(txHash)}`;
}
