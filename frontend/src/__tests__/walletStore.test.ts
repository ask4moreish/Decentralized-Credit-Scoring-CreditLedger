import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWalletStore } from '../store/walletStore';
import * as freighter from '../services/freighter';

describe('Wallet Store (Freighter Auth, Signing & Refresh Rotation)', () => {
  const pubKey = 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';

  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    useWalletStore.setState({
      isConnected: false,
      publicKey: null,
      token: null,
      refreshToken: null,
      role: 'borrower',
      roles: ['borrower'],
      isAdmin: false,
      balance: null,
      isLoading: false,
      error: null,
      txState: { stage: 'idle' },
    });
  });

  it('aborts wallet connect if Freighter signMessage declines instead of spoofing auth', async () => {
    vi.spyOn(freighter, 'checkFreighterConnected').mockResolvedValue(true);
    vi.spyOn(freighter, 'requestFreighterAccess').mockResolvedValue(pubKey);
    vi.spyOn(freighter, 'getFreighterNetworkPassphrase').mockResolvedValue(
      'Test SDF Network ; September 2015'
    );
    vi.spyOn(freighter, 'signAuthChallenge').mockRejectedValue(
      new Error('Wallet signature was declined or failed. Connection aborted.')
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ challenge: 'deadbeef'.repeat(8) }),
    } as Response);

    await expect(useWalletStore.getState().connect('lender')).rejects.toThrow(/declined/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Only GET /challenge; login never attempted!
    expect(useWalletStore.getState().isConnected).toBe(false);
    expect(useWalletStore.getState().token).toBeNull();
  });

  it('connects cleanly with real challenge signature and stores role & tokens', async () => {
    vi.spyOn(freighter, 'checkFreighterConnected').mockResolvedValue(true);
    vi.spyOn(freighter, 'requestFreighterAccess').mockResolvedValue(pubKey);
    vi.spyOn(freighter, 'getFreighterNetworkPassphrase').mockResolvedValue(
      'Test SDF Network ; September 2015'
    );
    vi.spyOn(freighter, 'signAuthChallenge').mockResolvedValue('ab'.repeat(64));

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/challenge')) {
        return { ok: true, text: async () => JSON.stringify({ challenge: 'cd'.repeat(32) }) } as Response;
      }
      if (url.endsWith('/auth/login')) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              token: 'jwt-access-1',
              refreshToken: 'refresh-1',
              publicKey: pubKey,
              role: 'lender',
              roles: ['borrower', 'lender'],
              isAdmin: false,
            }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ balances: [{ asset_type: 'native', balance: '9950.00' }] }),
      } as Response;
    });

    await useWalletStore.getState().connect('lender');
    const state = useWalletStore.getState();
    expect(state.isConnected).toBe(true);
    expect(state.role).toBe('lender');
    expect(state.token).toBe('jwt-access-1');
    await vi.waitFor(() => {
      expect(useWalletStore.getState().balance).toBe('9950.00');
    });
  });

  it('executes non-custodial prepare -> Freighter sign -> confirmed lifecycle cleanly', async () => {
    useWalletStore.setState({ isConnected: true, publicKey: pubKey, token: 'tok-1' });
    vi.spyOn(freighter, 'getFreighterNetworkPassphrase').mockResolvedValue(
      'Test SDF Network ; September 2015'
    );
    const signSpy = vi.spyOn(freighter, 'signSorobanXdr').mockResolvedValue('SIGNED_XDR_BLOB');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/loans/prepare-apply')) {
        return { ok: true, text: async () => JSON.stringify({ xdr: 'UNSIGNED_XDR_BLOB' }) } as Response;
      }
      if (url.endsWith('/loans/submit')) {
        return {
          ok: true,
          text: async () => JSON.stringify({ success: true, transactionHash: 'hash_ok_1', ledger: 5683000 }),
        } as Response;
      }
      return { ok: false, status: 404, text: async () => '' } as Response;
    });

    const res = await useWalletStore.getState().executeSignedTx({
      preparePath: '/loans/prepare-apply',
      prepareBody: { borrowerPublicKey: pubKey, amount: '100', durationMonths: 12 },
      submitPath: '/loans/submit',
      submitBody: { action: 'apply' },
    });

    expect(signSpy).toHaveBeenCalledWith('UNSIGNED_XDR_BLOB', pubKey, 'Test SDF Network ; September 2015');
    expect(res.transactionHash).toBe('hash_ok_1');
    expect(useWalletStore.getState().txState.stage).toBe('confirmed');
    expect(useWalletStore.getState().txState.txHash).toBe('hash_ok_1');
  });
});
