import { useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface PollState<T> {
  /** The last successful result; kept while a later poll fails, so the screen does not blank. */
  data?: T;
  error?: ApiError;
  updatedAtMs?: number;
}

/**
 * Polls `load` every `intervalMs`. It skips polls while the tab is hidden (the API is throttled
 * for a small account, and nobody is looking) and polls immediately when the tab is shown again.
 * Bump `refreshKey` to force an immediate poll.
 */
export function usePolling<T>(load: (signal: AbortSignal) => Promise<T>, intervalMs: number, refreshKey = 0): PollState<T> {
  const [state, setState] = useState<PollState<T>>({});
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const schedule = () => {
      if (!cancelled) timer = setTimeout(() => void run(), intervalMs);
    };

    const run = async () => {
      if (typeof document !== 'undefined' && document.hidden) {
        schedule();
        return;
      }
      controller = new AbortController();
      try {
        const data = await loadRef.current(controller.signal);
        if (!cancelled) setState({ data, updatedAtMs: Date.now() });
      } catch (err) {
        if (cancelled || (err as Error)?.name === 'AbortError') return;
        const error = err instanceof ApiError ? err : new ApiError(undefined, String((err as Error)?.message ?? err));
        setState((prev) => ({ ...prev, error }));
      }
      schedule();
    };

    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        clearTimeout(timer);
        void run();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, refreshKey]);

  return state;
}

/** A clock that re-renders its component every `everyMs` (for "3 s ago" labels). */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
