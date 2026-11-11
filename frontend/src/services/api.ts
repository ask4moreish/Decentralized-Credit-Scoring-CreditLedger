import { STELLAR_CONFIG } from '../config/stellar';

export interface AuthTokensProvider {
  getToken: () => string | null;
  getRefreshToken: () => string | null;
  setTokens: (token: string, refreshToken: string) => void;
  clearSession: () => void;
}

let tokensProvider: AuthTokensProvider | null = null;
let refreshPromise: Promise<string | null> | null = null;

export function registerAuthTokensProvider(provider: AuthTokensProvider): void {
  tokensProvider = provider;
}

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function tryRefreshSession(): Promise<string | null> {
  if (!tokensProvider) return null;
  const refreshToken = tokensProvider.getRefreshToken();
  if (!refreshToken) return null;

  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await fetch(`${STELLAR_CONFIG.apiUrl}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) {
          tokensProvider?.clearSession();
          return null;
        }
        const data = (await res.json()) as { token: string; refreshToken: string };
        tokensProvider?.setTokens(data.token, data.refreshToken);
        return data.token;
      } catch {
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

export async function apiRequest<T = any>(
  path: string,
  options: RequestInit & { idempotencyKey?: string; skipAuth?: boolean } = {}
): Promise<T> {
  const url = path.startsWith('http') ? path : `${STELLAR_CONFIG.apiUrl}${path}`;
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (options.idempotencyKey) {
    headers.set('Idempotency-Key', options.idempotencyKey);
  }
  const token = tokensProvider?.getToken();
  if (token && !options.skipAuth) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (response.status === 401 && !options.skipAuth && tokensProvider?.getRefreshToken()) {
    const newToken = await tryRefreshSession();
    if (newToken) {
      headers.set('Authorization', `Bearer ${newToken}`);
      response = await fetch(url, {
        ...options,
        headers,
        credentials: 'include',
      });
    }
  }

  const text = await response.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }

  if (!response.ok) {
    const msg =
      json.error ||
      (Array.isArray(json.errors) && json.errors[0]?.msg) ||
      `Request failed (${response.status})`;
    throw new ApiError(msg, response.status, json);
  }

  return json as T;
}
