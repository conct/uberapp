/**
 * React bindings for the RPC client.
 *
 * Deliberately small: a fetch-on-mount query hook with manual refresh, and a
 * mutation hook that reports progress. No cache — every screen is a live view
 * of the server, and stale service states are worse than a short spinner.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MethodName } from '@uberctrl/protocol';
import { client, RpcCallError, type ConnectionStatus } from './client';

export function useConnection(): ConnectionStatus {
  return useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getStatus(),
    () => client.getStatus(),
  );
}

export interface QueryResult<T> {
  data: T | null;
  error: string | null;
  /** True during the first load only; refreshes keep the old data visible. */
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
}

export function useQuery<T>(
  method: MethodName,
  params?: unknown,
  options: { enabled?: boolean; pollMs?: number } = {},
): QueryResult<T> {
  const { enabled = true, pollMs } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);

  const connection = useConnection();
  const paramsKey = JSON.stringify(params ?? null);
  // Kept in a ref so the fetch callback does not change identity per render.
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (isRefresh: boolean) => {
      // `loading` starts out as `enabled`, which is right for a query that is
      // on from the first render and wrong for one switched on later: that one
      // would sit at loading=false with no data while the call is in flight,
      // and the screen would render its "nothing here" branch instead of a
      // spinner. Refreshes keep their own flag so polling does not flicker.
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      try {
        const result = await client.call<T>(method, paramsRef.current);
        if (!mounted.current) return;
        setData(result);
        setError(null);
      } catch (err) {
        if (!mounted.current) return;
        setError(describeError(err));
      } finally {
        if (mounted.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [method],
  );

  useEffect(() => {
    if (!enabled || connection.state !== 'ready') return;
    void load(false);
    // paramsKey rather than params: a new object literal each render would
    // otherwise refetch forever.
  }, [enabled, connection.state, load, paramsKey]);

  useEffect(() => {
    if (!pollMs || !enabled || connection.state !== 'ready') return;
    const timer = setInterval(() => void load(true), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, enabled, connection.state, load]);

  const refresh = useCallback(() => void load(true), [load]);

  return { data, error, loading, refreshing, refresh };
}

export interface MutationResult<TArgs> {
  run: (args: TArgs) => Promise<unknown>;
  pending: boolean;
  error: string | null;
  /** Output text of the last successful call, when the agent returned any. */
  output: string | null;
  reset: () => void;
}

export function useMutation<TArgs = unknown>(
  method: MethodName,
  options: { onSuccess?: (data: unknown) => void } = {},
): MutationResult<TArgs> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const onSuccess = useRef(options.onSuccess);
  onSuccess.current = options.onSuccess;

  const run = useCallback(
    async (args: TArgs) => {
      setPending(true);
      setError(null);
      try {
        const data = await client.call(method, args);
        const text =
          data && typeof data === 'object' && 'output' in data
            ? String((data as { output: unknown }).output)
            : null;
        setOutput(text);
        onSuccess.current?.(data);
        return data;
      } catch (err) {
        setError(describeError(err));
        throw err;
      } finally {
        setPending(false);
      }
    },
    [method],
  );

  const reset = useCallback(() => {
    setError(null);
    setOutput(null);
  }, []);

  return { run, pending, error, output, reset };
}

/**
 * Subscribe to a streaming method and keep a bounded ring of lines.
 */
export function useLogStream(
  method: MethodName,
  params: unknown,
  options: { enabled?: boolean; maxLines?: number } = {},
) {
  const { enabled = true, maxLines = 500 } = options;
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);

  const connection = useConnection();
  const paramsKey = JSON.stringify(params ?? null);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  // Partial last line, kept until its newline arrives.
  const buffer = useRef('');

  useEffect(() => {
    if (!enabled || connection.state !== 'ready') return;

    setLines([]);
    setError(null);
    setActive(true);
    buffer.current = '';

    const handle = client.stream(
      method,
      paramsRef.current,
      (_stream, data) => {
        buffer.current += data;
        const parts = buffer.current.split('\n');
        buffer.current = parts.pop() ?? '';
        if (parts.length === 0) return;
        setLines((previous) => {
          const next = [...previous, ...parts];
          return next.length > maxLines ? next.slice(next.length - maxLines) : next;
        });
      },
      (err) => {
        setActive(false);
        if (err) setError(describeError(err));
      },
    );

    return () => {
      handle.cancel();
      setActive(false);
    };
  }, [method, paramsKey, enabled, connection.state, maxLines]);

  return { lines, error, active };
}

export function describeError(err: unknown): string {
  if (err instanceof RpcCallError) {
    return err.detail && err.detail !== err.message ? `${err.message}\n${err.detail}` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
