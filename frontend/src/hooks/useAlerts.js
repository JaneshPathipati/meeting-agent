// file: frontend/src/hooks/useAlerts.js
import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';

export function useAlerts(filters = {}) {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [totalCount, setTotalCount] = useState(0);
  const hasFetchedOnce = useRef(false);

  const fetchAlerts = useCallback(async () => {
    if (!hasFetchedOnce.current) {
      setLoading(true);
    }
    setError(null);
    try {
      let query = supabase
        .from('tone_alerts')
        .select('*, meetings!inner(start_time, detected_app, detected_category, profiles!inner(full_name, email))', { count: 'exact' })
        .order('created_at', { ascending: false });

      if (filters.severity) {
        query = query.eq('severity', filters.severity);
      }
      if (filters.isReviewed !== undefined) {
        query = query.eq('is_reviewed', filters.isReviewed);
      }
      if (filters.meetingId) {
        query = query.eq('meeting_id', filters.meetingId);
      }

      const page = filters.page || 0;
      const pageSize = filters.pageSize || 20;
      query = query.range(page * pageSize, (page + 1) * pageSize - 1);

      const { data, error: fetchError, count } = await query;

      if (fetchError) throw fetchError;

      setAlerts(data || []);
      setTotalCount(count || 0);
      hasFetchedOnce.current = true;
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filters.severity, filters.isReviewed, filters.meetingId, filters.page, filters.pageSize]);

  useEffect(() => {
    hasFetchedOnce.current = false;
    fetchAlerts();
  }, [fetchAlerts]);

  async function markReviewed(alertId) {
    const { error } = await supabase
      .from('tone_alerts')
      .update({ is_reviewed: true })
      .eq('id', alertId);

    if (!error) {
      setAlerts(prev => prev.map(a => a.id === alertId ? { ...a, is_reviewed: true } : a));
    }
    return { error };
  }

  async function markUnreviewed(alertId) {
    const { error } = await supabase
      .from('tone_alerts')
      .update({ is_reviewed: false })
      .eq('id', alertId);

    if (!error) {
      setAlerts(prev => prev.map(a => a.id === alertId ? { ...a, is_reviewed: false } : a));
    }
    return { error };
  }

  return { alerts, loading, error, totalCount, refetch: fetchAlerts, markReviewed, markUnreviewed };
}

export function useGroupedAlerts(filters = {}) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchGrouped = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let query = supabase
        .from('tone_alerts')
        .select('*, meetings!inner(id, start_time, end_time, duration_seconds, detected_app, detected_category, status, profiles!inner(full_name, email))')
        .order('start_time', { ascending: true });

      if (filters.severity) {
        query = query.eq('severity', filters.severity);
      }
      if (filters.isReviewed !== undefined) {
        query = query.eq('is_reviewed', filters.isReviewed);
      }

      const { data, error: fetchError } = await query;
      if (fetchError) throw fetchError;

      // Group alerts by meeting_id
      const map = new Map();
      (data || []).forEach(alert => {
        const mid = alert.meeting_id;
        if (!map.has(mid)) {
          map.set(mid, {
            meetingId: mid,
            meeting: alert.meetings,
            alerts: [],
          });
        }
        map.get(mid).alerts.push(alert);
      });

      // Sort groups by meeting start_time descending (newest first)
      const sorted = Array.from(map.values()).sort(
        (a, b) => new Date(b.meeting.start_time) - new Date(a.meeting.start_time)
      );

      setGroups(sorted);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filters.severity, filters.isReviewed]);

  useEffect(() => {
    fetchGrouped();
  }, [fetchGrouped]);

  async function markReviewed(alertId) {
    const { error } = await supabase
      .from('tone_alerts')
      .update({ is_reviewed: true })
      .eq('id', alertId);

    if (!error) {
      setGroups(prev => prev.map(g => ({
        ...g,
        alerts: g.alerts.map(a => a.id === alertId ? { ...a, is_reviewed: true } : a),
      })));
    }
    return { error };
  }

  async function markUnreviewed(alertId) {
    const { error } = await supabase
      .from('tone_alerts')
      .update({ is_reviewed: false })
      .eq('id', alertId);

    if (!error) {
      setGroups(prev => prev.map(g => ({
        ...g,
        alerts: g.alerts.map(a => a.id === alertId ? { ...a, is_reviewed: false } : a),
      })));
    }
    return { error };
  }

  return { groups, loading, error, refetch: fetchGrouped, markReviewed, markUnreviewed };
}

export function useMeetingsLog() {
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetch() {
      try {
        // Fetch all processed meetings
        const { data: meetingsData } = await supabase
          .from('meetings')
          .select('id, start_time, detected_app, detected_category, status, duration_seconds, profiles!inner(full_name)')
          .in('status', ['processed', 'uploaded', 'processing'])
          .order('start_time', { ascending: false })
          .limit(100);

        if (!meetingsData) { setMeetings([]); return; }

        // Fetch alert counts per meeting
        const { data: alertCounts } = await supabase
          .from('tone_alerts')
          .select('meeting_id')
          .limit(5000);

        const countMap = {};
        (alertCounts || []).forEach(a => {
          countMap[a.meeting_id] = (countMap[a.meeting_id] || 0) + 1;
        });

        setMeetings(meetingsData.map(m => ({
          ...m,
          alert_count: countMap[m.id] || 0,
        })));
      } catch (err) {
        console.error('Failed to fetch meetings log:', err);
      } finally {
        setLoading(false);
      }
    }
    fetch();
  }, []);

  return { meetings, loading };
}
