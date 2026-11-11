import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { STELLAR_CONFIG } from '../config/stellar';
import { apiRequest, registerAuthTokensProvider } from '../services/api';
import {
  checkFreighterConnected,
  getFreighterNetworkPassphrase,
  requestFreighterAccess,
  signAuthChallenge,
  signSorobanXdr,
} from '../services/freighter';

export type UserRole = 'borrower' | 'lender' | 'issuer' | 'admin';

export interface TxLifecycleState {
  stage: 'idle' | 'preparing' | 'awaiting_signature' | 'submitting' | 'confirmed' | 'error';
  message?: string;
  txHash?: string;
  ledger?: number | null;
}

interface WalletState {
  isConnected: boolean;
  publicKey: string | null;
  token: string | null;
  refreshToken: string | null;
  role: UserRole;
  roles: UserRole[];
  isAdmin: boolean;
  network: 'testnet' | 'mainnet';
  balance: string | null;
  isLoading: boolean;
  error: string | null;
  txState: TxLifecycleState;

  connect: (preferredRole?: 'borrower' | 'lender') => Promise<void>;
  disconnect: () => Promise<void>;
  refreshAccountBalance: () => Promise<void>;
  clearError: () => void;
  clearTxState: () => void;
  executeSignedTx: <T = any>(params: {
    preparePath: string;
    prepareBody: Record<string, unknown>;
    submitPath: string;
    submitBody?: Record<string, unknown>;
  }) => Promise<T>;
}

const INITIAL_TX: TxLifecycleState = { stage: 'idle' };

export const useWalletStore = create<WalletState>()(
  persist(
    (set, get) => ({
      isConnected: false,
      publicKey: null,
      token: null,
      refreshToken: null,
      role: 'borrower',
      roles: ['borrower'],
      isAdmin: false,
      network: STELLAR_CONFIG.network,
      balance: null,
      isLoading: false,
      error: null,
      txState: INITIAL_TX,

      connect: async (preferredRole = 'borrower') => {
        set({ isLoading: true, error: null });
        try {
          const available = await checkFreighterConnected();
          if (!available) {
            throw new Error(
              'Freighter wallet extension was not detected. Install or unlock Freighter to continue.'
            );
          }

          const publicKey = await requestFreighterAccess();
          const passphrase = await getFreighterNetworkPassphrase(STELLAR_CONFIG.networkPassphrase);

          const challengeRes = await apiRequest<{ challenge: string }>('/auth/challenge', {
            method: 'GET',
            skipAuth: true,
          });
          const signature = await signAuthChallenge(
            challengeRes.challenge,
            publicKey,
            passphrase
          );

          const authRes = await apiRequest<{
            token: string;
            refreshToken: string;
            publicKey: string;
            role: UserRole;
            roles: UserRole[];
            isAdmin: boolean;
          }>('/auth/login', {
            method: 'POST',
            skipAuth: true,
            body: JSON.stringify({
              publicKey,
              challenge: challengeRes.challenge,
              signature,
              role: preferredRole,
            }),
          });

          set({
            isConnected: true,
            publicKey: authRes.publicKey,
            token: authRes.token,
            refreshToken: authRes.refreshToken,
            role: authRes.role,
            roles: authRes.roles,
            isAdmin: authRes.isAdmin,
            isLoading: false,
            error: null,
          });

          void get().refreshAccountBalance();
        } catch (err) {
          set({
            isConnected: false,
            publicKey: null,
            token: null,
            refreshToken: null,
            isLoading: false,
            error: err instanceof Error ? err.message : 'Wallet connection failed',
          });
          throw err;
        }
      },

      disconnect: async () => {
        try {
          if (get().token) {
            await apiRequest('/auth/logout', { method: 'POST' }).catch(() => undefined);
          }
        } finally {
          set({
            isConnected: false,
            publicKey: null,
            token: null,
            refreshToken: null,
            role: 'borrower',
            roles: ['borrower'],
            isAdmin: false,
            balance: null,
            error: null,
            txState: INITIAL_TX,
          });
        }
      },

      refreshAccountBalance: async () => {
        const publicKey = get().publicKey;
        if (!publicKey) return;
        try {
          const res = await fetch(`${STELLAR_CONFIG.horizonUrl}/accounts/${publicKey}`);
          if (!res.ok) {
            set({ balance: '0 (Unfunded Testnet)' });
            return;
          }
          const data = (await res.json()) as {
            balances?: Array<{ asset_type: string; balance: string }>;
          };
          const native = data.balances?.find((b) => b.asset_type === 'native');
          set({ balance: native ? Number(native.balance).toFixed(2) : '0.00' });
        } catch {
          set({ balance: null });
        }
      },

      clearError: () => set({ error: null }),
      clearTxState: () => set({ txState: INITIAL_TX }),

      executeSignedTx: async <T = any>({
        preparePath,
        prepareBody,
        submitPath,
        submitBody = {},
      }: {
        preparePath: string;
        prepareBody: Record<string, unknown>;
        submitPath: string;
        submitBody?: Record<string, unknown>;
      }): Promise<T> => {
        const publicKey = get().publicKey;
        if (!publicKey) {
          throw new Error('Connect your Freighter wallet first.');
        }

        const idempotencyKey =
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `tx-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        try {
          set({
            txState: {
              stage: 'preparing',
              message: 'Preparing Soroban transaction & simulation footprint...',
            },
          });

          const prepRes = await apiRequest<{ xdr: string }>(preparePath, {
            method: 'POST',
            idempotencyKey: `${idempotencyKey}-prep`,
            body: JSON.stringify(prepareBody),
          });

          set({
            txState: {
              stage: 'awaiting_signature',
              message: 'Approve & sign the transaction in Freighter...',
            },
          });

          const passphrase = await getFreighterNetworkPassphrase(STELLAR_CONFIG.networkPassphrase);
          const signedXDR = await signSorobanXdr(prepRes.xdr, publicKey, passphrase);

          set({
            txState: {
              stage: 'submitting',
              message: 'Submitting to Stellar Soroban & waiting for ledger confirmation...',
            },
          });

          const submitRes = await apiRequest<T & { transactionHash?: string; ledger?: number | null }>(
            submitPath,
            {
              method: 'POST',
              idempotencyKey: `${idempotencyKey}-sub`,
              body: JSON.stringify({
                ...submitBody,
                signedXDR,
              }),
            }
          );

          set({
            txState: {
              stage: 'confirmed',
              message: 'Confirmed on Stellar Soroban!',
              txHash: submitRes.transactionHash,
              ledger: submitRes.ledger ?? null,
            },
          });

          void get().refreshAccountBalance();
          return submitRes;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Transaction failed';
          set({
            txState: {
              stage: 'error',
              message: msg,
            },
          });
          throw err;
        }
      },
    }),
    {
      name: 'creditledger-wallet-session',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        isConnected: state.isConnected,
        publicKey: state.publicKey,
        token: state.token,
        refreshToken: state.refreshToken,
        role: state.role,
        roles: state.roles,
        isAdmin: state.isAdmin,
        network: state.network,
      }),
    }
  )
);

registerAuthTokensProvider({
  getToken: () => useWalletStore.getState().token,
  getRefreshToken: () => useWalletStore.getState().refreshToken,
  setTokens: (token, refreshToken) => useWalletStore.setState({ token, refreshToken }),
  clearSession: () =>
    useWalletStore.setState({
      isConnected: false,
      publicKey: null,
      token: null,
      refreshToken: null,
      isAdmin: false,
      roles: ['borrower'],
    }),
});
