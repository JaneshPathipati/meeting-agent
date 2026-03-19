// file: frontend/src/hooks/useMeetings.js
import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';

export function useMeetings(filters = {}) {
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [totalCount, setTotalCount] = useState(0);
  const hasFetchedOnce = useRef(false);

  const fetchMeetings = useCallback(async () => {
    // Only show loading spinner on initial load, not on background refetches (realtime).
    // This prevents the table from flickering (disappear → spinner → reappear).
    if (!hasFetchedOnce.current) {
      setLoading(true);
    }
    setError(null);
    try {
      let query = supabase
        .from('meetings')
        .select('*, profiles!inner(full_name, email, microsoft_email, department)', { count: 'exact' })
        .order('created_at', { ascending: false });

      if (filters.userId) {
        query = query.eq('user_id', filters.userId);
      }
      if (filters.status) {
        query = query.eq('status', filters.status);
      }
      if (filters.category) {
        query = query.eq('detected_category', filters.category);
      }
      if (filters.dateFrom) {
        query = query.gte('start_time', filters.dateFrom);
      }
      if (filters.dateTo) {
        query = query.lte('start_time', filters.dateTo);
      }
      if (filters.search) {
        const term = `%${filters.search}%`;
        query = query.or(`full_name.ilike.${term},microsoft_email.ilike.${term}`, { foreignTable: 'profiles' });
      }
      // Note: full-text search on transcript content is done via search_meetings RPC
      // (see useTranscriptSearch hook below), not inline here, to avoid complex joins.

      const page = filters.page || 0;
      const pageSize = filters.pageSize || 20;
      query = query.range(page * pageSize, (page + 1) * pageSize - 1);

      const { data, error: fetchError, count } = await query;

      if (fetchError) throw fetchError;

      setMeetings(data || []);
      setTotalCount(count || 0);
      hasFetchedOnce.current = true;
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filters.userId, filters.status, filters.category, filters.dateFrom, filters.dateTo, filters.search, filters.page, filters.pageSize]);

  // Reset hasFetchedOnce when filters change so filter changes show the spinner
  useEffect(() => {
    hasFetchedOnce.current = false;
    fetchMeetings();
  }, [fetchMeetings]);

  return { meetings, loading, error, totalCount, refetch: fetchMeetings };
}

/**
 * Full-text search across meeting transcripts using the search_meetings RPC.
 * Returns a flat list of meetings ranked by relevance.
 */
export function useTranscriptSearch(orgId, query) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!query || query.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    supabase.rpc('search_meetings', {
      p_org_id: orgId,
      p_query: query.trim(),
      p_limit: 20,
    }).then(({ data, error: rpcError }) => {
      if (cancelled) return;
      if (rpcError) {
        setError(rpcError.message);
      } else {
        setResults(data || []);
      }
      setLoading(false);
    }).catch(err => {
      if (cancelled) return;
      setError(err.message || 'Search failed');
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [orgId, query]);

  return { results, loading, error };
}

export function useMeetingDetail(meetingId) {
  const [meeting, setMeeting] = useState(null);
  const [transcript, setTranscript] = useState(null);
  const [summary, setSummary] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchDetail = useCallback(async () => {
    if (!meetingId) return;
    setLoading(true);
    try {
      const [meetingRes, transcriptRes, summaryRes, alertsRes] = await Promise.all([
        supabase.from('meetings').select('*, profiles!inner(full_name, email, microsoft_email, department)').eq('id', meetingId).single(),
        supabase.from('transcripts').select('*').eq('meeting_id', meetingId).maybeSingle(),
        supabase.from('summaries').select('*').eq('meeting_id', meetingId).eq('is_default', true).maybeSingle(),
        supabase.from('tone_alerts').select('*').eq('meeting_id', meetingId).order('start_time', { ascending: true }),
      ]);

      if (meetingRes.error) throw meetingRes.error;
      if (transcriptRes.error) throw transcriptRes.error;
      if (summaryRes.error) throw summaryRes.error;
      if (alertsRes.error) throw alertsRes.error;

      setMeeting(meetingRes.data);
      setTranscript(transcriptRes.data);
      setSummary(summaryRes.data);
      setAlerts(alertsRes.data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [meetingId]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  // Realtime: keep meeting detail live without polling
  useEffect(() => {
    if (!meetingId) return;

    const channel = supabase
      .channel(`meeting-detail-${meetingId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'meetings',
        filter: `id=eq.${meetingId}`,
      }, (payload) => {
        setMeeting(prev => prev ? { ...payload.new, profiles: prev.profiles } : null);
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'transcripts',
        filter: `meeting_id=eq.${meetingId}`,
      }, async () => {
        // Refetch full transcript from DB instead of using payload.new.
        // Realtime payloads have a ~1MB size limit — transcript_json often exceeds this,
        // causing payload.new.transcript_json to arrive as null/truncated.
        const { data } = await supabase.from('transcripts').select('*').eq('meeting_id', meetingId).maybeSingle();
        if (data) setTranscript(data);
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'summaries',
        filter: `meeting_id=eq.${meetingId}`,
      }, async () => {
        // Refetch summary from DB — same payload size concern as transcripts,
        // and also catches UPDATEs (not just INSERTs) from reprocessing.
        const { data } = await supabase.from('summaries').select('*').eq('meeting_id', meetingId).eq('is_default', true).maybeSingle();
        if (data) setSummary(data);
      })
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'tone_alerts',
        filter: `meeting_id=eq.${meetingId}`,
      }, (payload) => {
        setAlerts(prev => {
          if (prev.some(a => a.id === payload.new.id)) return prev;
          return [...prev, payload.new].sort((a, b) =>
            (a.start_time || '').localeCompare(b.start_time || ''));
        });
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [meetingId]);

  return { meeting, transcript, summary, alerts, loading, error, refetch: fetchDetail };
}
