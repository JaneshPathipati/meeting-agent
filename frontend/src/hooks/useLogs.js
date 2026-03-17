// file: frontend/src/hooks/useLogs.js
import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';

export function useLogs(filters = {}) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [totalCount, setTotalCount] = useState(0);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let query = supabase
        .from('agent_logs')
        .select('*, profiles(full_name)', { count: 'exact' })
        .order('logged_at', { ascending: false });

      if (filters.profileId) query = query.eq('profile_id', filters.profileId);
      if (filters.level)     query = query.eq('level', filters.level);
      if (filters.module)    query = query.ilike('module', `%${filters.module}%`);
      if (filters.search)    query = query.ilike('message', `%${filters.search}%`);
      if (filters.dateFrom)  query = query.gte('logged_at', filters.dateFrom);
      if (filters.dateTo)    query = query.lte('logged_at', `${filters.dateTo}T23:59:59`);

      const page = filters.page || 0;
      const pageSize = filters.pageSize || 50;
      query = query.range(page * pageSize, (page + 1) * pageSize - 1);

      const { data, error: fetchError, count } = await query;
      if (fetchError) throw fetchError;
      setLogs(data || []);
      setTotalCount(count || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [
    filters.profileId, filters.level, filters.module, filters.search,
    filters.dateFrom, filters.dateTo, filters.page, filters.pageSize,
  ]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  return { logs, loading, error, totalCount, refetch: fetchLogs };
}
