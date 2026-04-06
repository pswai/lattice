const KEY_STORE = 'lattice.apiKey';

let apiCallCount = 0;

export function getApiKey(): string | null {
  return localStorage.getItem(KEY_STORE);
}

export function setApiKey(key: string): void {
  localStorage.setItem(KEY_STORE, key);
}

export function clearApiKey(): void {
  localStorage.removeItem(KEY_STORE);
}

export function getApiCallCount(): number {
  return apiCallCount;
}

export async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const key = getApiKey();
  apiCallCount++;

  const res = await fetch('/api/v1' + path, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + key,
      ...opts?.headers,
    },
  });

  if (res.status === 401) {
    clearApiKey();
    window.location.reload();
    throw new Error('unauthorized');
  }

  if (res.status === 429) {
    throw new Error('rate_limited');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(body.message || `HTTP ${res.status}`);
  }

  return res.json();
}
