import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../lib/api';
import type { DashboardSnapshot } from '../lib/types';

const POLL_INTERVAL = 30_000;
const DEBOUNCE_MS = 5_000;

interface UseDashboardReturn {
  data: DashboardSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useDashboard(): UseDashboardReturn {
  const [data, setData] = useState<DashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastFetchRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchData = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && now - lastFetchRef.current < DEBOUNCE_MS) return;
    lastFetchRef.current = now;

    try {
      const snapshot = await api<DashboardSnapshot>('/dashboard-snapshot');
      setData(snapshot);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      if (msg !== 'unauthorized') {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    fetchData(true);
  }, [fetchData]);

  useEffect(() => {
    fetchData(true);

    const interval = setInterval(() => fetchData(), POLL_INTERVAL);
    return () => {
      clearInterval(interval);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [fetchData]);

  return { data, loading, error, refresh };
}
