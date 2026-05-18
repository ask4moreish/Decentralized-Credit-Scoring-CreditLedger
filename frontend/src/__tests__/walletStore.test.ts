import { act } from '@testing-library/react';
import { useWalletStore } from '../store/walletStore';

// Reset store state between tests
beforeEach(() => {
  useWalletStore.setState({
    isConnected: false,
    isConnecting: false,
    publicKey: null,
    error: null,
  });
});

describe('walletStore', () => {
  it('has correct initial state', () => {
    const state = useWalletStore.getState();
    expect(state.isConnected).toBe(false);
    expect(state.publicKey).toBeNull();
    expect(state.error).toBeNull();
  });

  it('disconnect clears wallet state', () => {
    useWalletStore.setState({ isConnected: true, publicKey: 'GABC' });
    act(() => useWalletStore.getState().disconnect());
    const state = useWalletStore.getState();
    expect(state.isConnected).toBe(false);
    expect(state.publicKey).toBeNull();
  });

  it('setError updates error state', () => {
    act(() => useWalletStore.getState().setError('something went wrong'));
    expect(useWalletStore.getState().error).toBe('something went wrong');
  });

  it('setConnecting updates isConnecting', () => {
    act(() => useWalletStore.getState().setConnecting(true));
    expect(useWalletStore.getState().isConnecting).toBe(true);
  });

  it('connect throws when Freighter is not available', async () => {
    // Ensure window.freighter is undefined
    (window as any).freighter = undefined;
    await expect(useWalletStore.getState().connect()).rejects.toThrow('Freighter wallet not detected');
    expect(useWalletStore.getState().isConnecting).toBe(false);
  });

  it('connect throws when on wrong network', async () => {
    (window as any).freighter = {
      getNetwork: async () => 'mainnet',
      getPublicKey: async () => 'GABC',
      isConnected: async () => true,
    };
    await expect(useWalletStore.getState().connect()).rejects.toThrow('Please switch to');
  });

  it('connect sets publicKey on success', async () => {
    (window as any).freighter = {
      getNetwork: async () => 'testnet',
      getPublicKey: async () => 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      isConnected: async () => true,
    };
    await act(async () => { await useWalletStore.getState().connect(); });
    const state = useWalletStore.getState();
    expect(state.isConnected).toBe(true);
    expect(state.publicKey).toBe('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN');
  });
});
