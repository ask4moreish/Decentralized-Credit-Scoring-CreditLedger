import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { ALLOWED_NETWORK } from '../config/stellar';

interface WalletState {
  isConnected: boolean;
  isConnecting: boolean;
  publicKey: string | null;
  network: string;
  error: string | null;
  
  // Actions
  connect: () => Promise<void>;
  disconnect: () => void;
  setError: (error: string | null) => void;
  setConnecting: (isConnecting: boolean) => void;
}

export const useWalletStore = create<WalletState>()(
  devtools(
    persist(
      (set, get) => ({
        isConnected: false,
        isConnecting: false,
        publicKey: null,
        network: ALLOWED_NETWORK,
        error: null,

        connect: async () => {
          const { setError, setConnecting } = get();
          
          try {
            setConnecting(true);
            setError(null);

            // Check if Freighter is available
            if (!window.freighter) {
              throw new Error('Freighter wallet not detected. Please install Freighter extension.');
            }

            // Get network from Freighter
            const freighterNetwork = await window.freighter.getNetwork();
            
            if (freighterNetwork !== ALLOWED_NETWORK) {
              throw new Error(`Please switch to ${ALLOWED_NETWORK} network in Freighter.`);
            }

            // Get public key
            const publicKey = await window.freighter.getPublicKey();
            
            if (!publicKey) {
              throw new Error('Failed to get public key from wallet.');
            }

            set({
              isConnected: true,
              publicKey,
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
          set({
            isConnected: false,
            publicKey: null,
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
      }),
      {
        name: 'credit-ledger-wallet',
        partialize: (state) => ({
          publicKey: state.publicKey,
          network: state.network,
        }),
      }
    )
  )
);

// Type declaration for Freighter API
declare global {
  interface Window {
    freighter?: {
      getPublicKey: () => Promise<string>;
      signTransaction: (xdr: string, network: string) => Promise<string>;
      getNetwork: () => Promise<string>;
      isConnected: () => Promise<boolean>;
    };
  }
}
