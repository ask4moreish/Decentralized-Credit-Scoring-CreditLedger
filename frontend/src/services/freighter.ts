import * as FreighterApi from '@stellar/freighter-api';

export interface FreighterBridge {
  isConnected: () => Promise<{ isConnected: boolean; error?: unknown }>;
  requestAccess: () => Promise<{ address: string; error?: unknown }>;
  getAddress: () => Promise<{ address: string; error?: unknown }>;
  getNetworkDetails: () => Promise<{
    network: string;
    networkPassphrase: string;
    error?: unknown;
  }>;
  signMessage: (
    message: string,
    opts?: { networkPassphrase?: string; address?: string }
  ) => Promise<{ signedMessage: string | Uint8Array | null; signerAddress: string; error?: unknown }>;
  signTransaction: (
    transactionXdr: string,
    opts?: { networkPassphrase?: string; address?: string }
  ) => Promise<{ signedTxXdr: string; signerAddress: string; error?: unknown }>;
}

function getBridge(): FreighterBridge {
  // Dev/E2E browser bridge only outside production bundles; tree-shaken when PROD=true.
  if (!import.meta.env.PROD && typeof window !== 'undefined') {
    const injected = (window as unknown as { __FREIGHTER_TEST_BRIDGE__?: FreighterBridge })
      .__FREIGHTER_TEST_BRIDGE__;
    if (injected) return injected;
  }
  return FreighterApi as unknown as FreighterBridge;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function checkFreighterConnected(): Promise<boolean> {
  const res = await getBridge().isConnected();
  if (res.error) return false;
  return Boolean(res.isConnected);
}

export async function requestFreighterAccess(): Promise<string> {
  const res = await getBridge().requestAccess();
  if (res.error || !res.address) {
    throw new Error(
      typeof res.error === 'object' && res.error && 'message' in res.error
        ? String((res.error as { message: unknown }).message)
        : 'Freighter wallet access was denied'
    );
  }
  return res.address;
}

export async function getFreighterNetworkPassphrase(fallback: string): Promise<string> {
  try {
    const net = await getBridge().getNetworkDetails();
    if (!net.error && net.networkPassphrase) return net.networkPassphrase;
  } catch {
    // Use configured network passphrase fallback
  }
  return fallback;
}

export async function signAuthChallenge(
  challenge: string,
  address: string,
  networkPassphrase: string
): Promise<string> {
  const res = await getBridge().signMessage(challenge, { address, networkPassphrase });
  if (res.error || !res.signedMessage) {
    throw new Error('Wallet signature was declined or failed. Connection aborted.');
  }
  if (typeof res.signedMessage === 'string') {
    return res.signedMessage;
  }
  return bytesToBase64(new Uint8Array(res.signedMessage));
}

export async function signSorobanXdr(
  unsignedXdr: string,
  address: string,
  networkPassphrase: string
): Promise<string> {
  const res = await getBridge().signTransaction(unsignedXdr, {
    address,
    networkPassphrase,
  });
  if (res.error || !res.signedTxXdr) {
    throw new Error('Transaction signature was declined or failed in Freighter.');
  }
  return res.signedTxXdr;
}
