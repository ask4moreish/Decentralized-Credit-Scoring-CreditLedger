import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { ALLOWED_NETWORK, NETWORK_PASSPHRASE, API_URL } from '../config/stellar';
import * as freighter from '@stellar/freighter-api';

interface WalletState {
  isConnected: boolean;
  isConnecting: boolean;
  publicKey: string | null;
  network: string;
  authToken: string | null;
  isAdmin: boolean;
  error: string | null;

  // Actions
  connect: () => Promise<void>;
  disconnect: () => void;
  setError: (error: string | null) => void;
  setConnecting: (isConnecting: boolean) => void;
  getAuthToken: () => string | null;
  signTransaction: (xdr: string) => Promise<string>;
}

export const useWalletStore = create<WalletState>()(
  devtools(
    persist(
      (set, get) => ({
        isConnected: false,
        isConnecting: false,
        publicKey: null,
        network: ALLOWED_NETWORK,
        authToken: typeof localStorage !== 'undefined' ? localStorage.getItem('auth_token') : null,
        isAdmin: false,
        error: null,

        connect: async () => {
          const { setError, setConnecting } = get();

          try {
            setConnecting(true);
            setError(null);

            // Check if Freighter is available in window or via freighter-api
            const hasWindowFreighter = typeof window !== 'undefined' && Boolean((window as any).freighter);
            let isFreighterConnected = false;

            if (hasWindowFreighter) {
              isFreighterConnected = true;
            } else {
              try {
                const conn = await freighter.isConnected();
                isFreighterConnected = typeof conn === 'boolean' ? conn : Boolean(conn?.isConnected);
              } catch {
                isFreighterConnected = false;
              }
            }

            if (!isFreighterConnected && !hasWindowFreighter) {
              throw new Error('Freighter wallet not detected. Please install Freighter extension.');
            }

            // Verify network
            let currentNetwork = '';
            if (hasWindowFreighter && typeof (window as any).freighter.getNetwork === 'function') {
              const winNet = await (window as any).freighter.getNetwork();
              currentNetwork = typeof winNet === 'string' ? winNet : winNet?.network || '';
            } else {
              try {
                const netObj = await freighter.getNetwork();
                currentNetwork = typeof netObj === 'string' ? netObj : (netObj as any)?.network || '';
              } catch {
                currentNetwork = ALLOWED_NETWORK;
              }
            }

            if (currentNetwork && currentNetwork.toLowerCase() !== ALLOWED_NETWORK.toLowerCase()) {
              throw new Error(`Please switch to ${ALLOWED_NETWORK} network in Freighter.`);
            }

            // Get public key
            let userPublicKey = '';
            if (hasWindowFreighter && typeof (window as any).freighter.getPublicKey === 'function') {
              userPublicKey = await (window as any).freighter.getPublicKey();
            } else {
              try {
                const addrResult = await freighter.getAddress();
                userPublicKey = typeof addrResult === 'string' ? addrResult : (addrResult as any)?.address || '';
              } catch {
                userPublicKey = '';
              }
            }

            if (!userPublicKey) {
              throw new Error('Failed to get public key from wallet.');
            }

            // Authenticate with backend and obtain JWT session
            let token: string | null = null;
            let isAdminUser = false;

            try {
              const challengeRes = await fetch(`${API_URL}/api/auth/challenge`);
              if (challengeRes.ok) {
                const { challenge } = await challengeRes.json();
                let signatureHex = '';

                if (typeof freighter.signMessage === 'function') {
                  const signed = await freighter.signMessage(challenge);
                  signatureHex = typeof signed === 'string' ? signed : Buffer.from((signed as any).signature).toString('hex');
                } else {
                  signatureHex = Buffer.from(challenge).toString('hex');
                }

                const loginRes = await fetch(`${API_URL}/api/auth/login`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    publicKey: userPublicKey,
                    signature: signatureHex,
                    challenge,
                  }),
                });

                if (loginRes.ok) {
                  const loginData = await loginRes.json();
                  token = loginData.token;
                  isAdminUser = Boolean(loginData.isAdmin);
                  if (typeof localStorage !== 'undefined' && token) {
                    localStorage.setItem('auth_token', token);
                  }
                }
              }
            } catch {
              // Standalone / offline mode fallback
            }

            set({
              isConnected: true,
              publicKey: userPublicKey,
              authToken: token,
              isAdmin: isAdminUser,
              network: currentNetwork || ALLOWED_NETWORK,
              error: null,
              isConnecting: false,
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Failed to connect wallet';
            setError(errorMessage);
            set({ isConnecting: false });
            throw error;
          }
        },

        disconnect: () => {
          if (typeof localStorage !== 'undefined') {
            localStorage.removeItem('auth_token');
          }
          set({
            isConnected: false,
            publicKey: null,
            authToken: null,
            isAdmin: false,
            error: null,
            isConnecting: false,
          });
        },

        setError: (error) => {
          set({ error });
        },

        setConnecting: (isConnecting) => {
          set({ isConnecting });
        },

        getAuthToken: () => {
          return get().authToken || (typeof localStorage !== 'undefined' ? localStorage.getItem('auth_token') : null);
        },

        signTransaction: async (xdr: string) => {
          if (typeof (window as any)?.freighter?.signTransaction === 'function') {
            return await (window as any).freighter.signTransaction(xdr, { networkPassphrase: NETWORK_PASSPHRASE });
          }
          const result = await freighter.signTransaction(xdr, { networkPassphrase: NETWORK_PASSPHRASE });
          return typeof result === 'string' ? result : (result as any)?.signedTxXdr || xdr;
        },
      }),
      {
        name: 'credit-ledger-wallet',
        partialize: (state) => ({
          publicKey: state.publicKey,
          network: state.network,
          authToken: state.authToken,
          isAdmin: state.isAdmin,
        }),
      }
    )
  )
);

// Type declaration for Freighter API
declare global {
  interface Window {
    freighter?: {
      isConnected: () => Promise<boolean>;
      getPublicKey: () => Promise<string>;
      getNetwork: () => Promise<string>;
      signTransaction?: (xdr: string, opts?: any) => Promise<string>;
      sign?: (data: any) => Promise<any>;
    };
  }
}
