// file: frontend/src/hooks/useRealtime.js
import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

export function useRealtime(table, callback, filter, onError) {
  const callbackRef = useRef(callback);
  const filterRef = useRef(filter);
  const onErrorRef = useRef(onError);

  // Keep refs current without triggering re-subscription
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const channel = supabase
      .channel(`admin-${table}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table,
          ...(filterRef.current || {})
        },
        (payload) => {
          callbackRef.current(payload);
        }
      )
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          if (onErrorRef.current) {
            onErrorRef.current(err || new Error(`Realtime channel ${status.toLowerCase()} for ${table}`));
          }
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [table]);
}
