// file: frontend/src/pages/SearchPage.jsx
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTranscriptSearch } from '../hooks/useMeetings';
import { Search, X, FileText, Clock, Monitor, Tag, Loader2, ArrowRight } from 'lucide-react';
import ErrorBoundary from '../components/shared/ErrorBoundary';

/* ── Highlight matching text ─────────────────────────────────────── */
function HighlightedText({ text, query }) {
  if (!text || !query) return <span>{text}</span>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);
  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="bg-[#FFF3E8] text-[#EA580C] font-semibold px-0.5 not-italic">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
}

/* ── Result card ─────────────────────────────────────────────────── */
function ResultCard({ result, query, index }) {
  const navigate = useNavigate();

  return (
    <div
      onClick={() => navigate(`/meetings/${result.meeting_id}`)}
      className="glass-card p-5 cursor-pointer group animate-slide-up"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {/* Meta row */}
          <div className="flex flex-wrap items-center gap-3 mb-2">
            <span className="text-[13px] font-semibold text-[#020617]">
              {result.user_name || 'Unknown'}
            </span>
            {result.start_time && (
              <span className="flex items-center gap-1 text-[11px] text-[#94A3B8]">
                <Clock className="h-3 w-3" />
                {new Date(result.start_time).toLocaleDateString('en-GB', {
                  day: '2-digit', month: 'short', year: 'numeric',
                })}
              </span>
            )}
            {result.detected_app && (
              <span className="flex items-center gap-1 text-[11px] text-[#94A3B8]">
                <Monitor className="h-3 w-3" />
                {result.detected_app}
              </span>
            )}
            {result.detected_category && (
              <span className="text-[11px] px-1.5 py-0.5 bg-[#F1F5F9] text-[#64748B]">
                {result.detected_category.replace(/_/g, ' ')}
              </span>
            )}
          </div>

          {/* Matched excerpt */}
          {result.excerpt && (
            <div className="flex gap-2">
              <FileText className="h-3.5 w-3.5 text-[#CBD5E1] flex-shrink-0 mt-0.5" />
              <p className="text-[13px] text-[#475569] leading-relaxed line-clamp-3 italic">
                "…<HighlightedText text={result.excerpt} query={query} />…"
              </p>
            </div>
          )}

          {/* Summary snippet if available */}
          {result.summary_snippet && !result.excerpt && (
            <p className="text-[13px] text-[#475569] leading-relaxed line-clamp-2">
              <HighlightedText text={result.summary_snippet} query={query} />
            </p>
          )}
        </div>

        <ArrowRight className="h-4 w-4 text-[#CBD5E1] group-hover:text-[#F97316] transition-colors flex-shrink-0 mt-0.5" />
      </div>

      {/* Bottom accent bar */}
      <div
        className="mt-4 h-[2px] w-0 group-hover:w-full transition-all duration-300"
        style={{ background: 'linear-gradient(90deg, #F97316, #FFD4AA)' }}
      />
    </div>
  );
}

/* ── Main Search page ────────────────────────────────────────────── */
function SearchInner() {
  const { profile } = useAuth();
  const [inputValue, setInputValue] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  const { results, loading, error } = useTranscriptSearch(
    profile?.org_id,
    debouncedQuery
  );

  // Debounce 350ms
  const handleChange = useCallback((val) => {
    setInputValue(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(val.trim());
    }, 350);
  }, []);

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const hasQuery = debouncedQuery.length >= 2;
  const showEmpty = hasQuery && !loading && results.length === 0 && !error;

  return (
    <div className="space-y-6 animate-page-reveal">

      {/* Header */}
      <div className="animate-fade-in">
        <p className="text-[11px] uppercase tracking-[0.34em] text-[#64748B]">Transcript</p>
        <h2 className="mt-1 text-[28px] font-semibold tracking-tight text-[#020617] leading-tight">
          Search
        </h2>
      </div>

      {/* Search bar */}
      <div
        className="glass-panel p-5 animate-slide-up"
        style={{ animationDelay: '60ms' }}
      >
        <div className="relative">
          <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
            {loading ? (
              <Loader2 className="h-5 w-5 text-[#F97316] animate-spin" />
            ) : (
              <Search className="h-5 w-5 text-[#94A3B8]" />
            )}
          </div>
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={e => handleChange(e.target.value)}
            placeholder="Search across all meeting transcripts..."
            className="w-full pl-12 pr-12 py-3.5 text-[15px] border border-[#E2E8F0] bg-white focus:outline-none focus:border-[#F97316] focus:ring-2 focus:ring-[#F97316]/20 transition-all duration-200 text-[#020617] placeholder-[#CBD5E1]"
          />
          {inputValue && (
            <button
              onClick={() => { setInputValue(''); setDebouncedQuery(''); inputRef.current?.focus(); }}
              className="absolute inset-y-0 right-4 flex items-center text-[#94A3B8] hover:text-[#64748B] transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {!hasQuery && (
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="text-[11px] text-[#94A3B8]">Try:</span>
            {['action items', 'budget', 'follow up', 'deadline', 'concern'].map(hint => (
              <button
                key={hint}
                onClick={() => { setInputValue(hint); setDebouncedQuery(hint); }}
                className="text-[11px] px-2 py-0.5 border border-[#E2E8F0] text-[#64748B] hover:border-[#F97316] hover:text-[#F97316] transition-all duration-150"
              >
                {hint}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="glass-panel px-5 py-4 border-l-4 border-red-400">
          <p className="text-[13px] text-red-600">{error}</p>
        </div>
      )}

      {/* Results count */}
      {hasQuery && !loading && results.length > 0 && (
        <p className="text-[12px] text-[#94A3B8] px-1 animate-fade-in">
          {results.length} result{results.length !== 1 ? 's' : ''} for "{debouncedQuery}"
        </p>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-3">
          {results.map((result, i) => (
            <ResultCard
              key={result.meeting_id || i}
              result={result}
              query={debouncedQuery}
              index={i}
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {showEmpty && (
        <div className="glass-panel py-14 text-center animate-fade-in">
          <Search className="h-10 w-10 text-[#E2E8F0] mx-auto mb-3" />
          <p className="text-[14px] font-medium text-[#020617]">No results found</p>
          <p className="text-[12px] text-[#94A3B8] mt-1">
            No transcript content matches "<span className="font-medium">{debouncedQuery}</span>"
          </p>
        </div>
      )}

      {/* Initial empty state */}
      {!hasQuery && !loading && (
        <div className="glass-panel py-14 text-center animate-fade-in" style={{ animationDelay: '120ms' }}>
          <FileText className="h-10 w-10 text-[#E2E8F0] mx-auto mb-3" />
          <p className="text-[14px] font-medium text-[#020617]">Search meeting transcripts</p>
          <p className="text-[12px] text-[#94A3B8] mt-1 max-w-xs mx-auto">
            Enter at least 2 characters to search across all recorded meeting transcripts
          </p>
        </div>
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <ErrorBoundary>
      <SearchInner />
    </ErrorBoundary>
  );
}
