import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api.js';
import './SearchModal.css';

interface SearchResult {
  id: string;
  text: string;
  fromNodeId?: string;
  fromNodeNum?: number;
  fromPublicKey?: string;
  toNodeId?: string;
  toNodeNum?: number;
  toPublicKey?: string;
  channel?: number;
  timestamp: number;
  rxTime?: number;
  source: 'standard' | 'meshcore';
}

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateToMessage: (result: SearchResult) => void;
  channels: Array<{ id: number; name: string }>;
  nodes: Array<{ nodeId: string; longName: string; shortName: string }>;
}

const RESULTS_PER_PAGE = 25;

export const SearchModal: React.FC<SearchModalProps> = ({
  isOpen,
  onClose,
  onNavigateToMessage,
  channels,
  nodes,
}) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [scope, setScope] = useState<'all' | 'channels' | 'dms' | 'meshcore'>('all');
  const [selectedChannels, setSelectedChannels] = useState<number[]>([]);
  const [senderNodeId, setSenderNodeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // Auto-focus search input on open
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const performSearch = useCallback(async (offset: number) => {
    setLoading(true);
    setError(false);
    try {
      const params: Parameters<typeof apiService.searchMessages>[0] = {
        q: query,
        caseSensitive: caseSensitive || undefined,
        scope: scope !== 'all' ? scope : undefined,
        channels: selectedChannels.length > 0 ? selectedChannels : undefined,
        fromNodeId: senderNodeId || undefined,
        startDate: startDate ? Math.floor(new Date(startDate).getTime() / 1000) : undefined,
        endDate: endDate ? Math.floor(new Date(endDate + 'T23:59:59').getTime() / 1000) : undefined,
        limit: RESULTS_PER_PAGE,
        offset,
      };
      const response = await apiService.searchMessages(params);
      if (offset === 0) {
        setResults(response.data);
      } else {
        setResults(prev => [...prev, ...response.data]);
      }
      setTotal(response.total);
      setHasSearched(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [query, caseSensitive, scope, selectedChannels, senderNodeId, startDate, endDate]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.length < 2) return;
    performSearch(0);
  };

  const handleLoadMore = () => {
    performSearch(results.length);
  };

  const handleResultClick = (result: SearchResult) => {
    onNavigateToMessage(result);
    onClose();
  };

  const formatTimestamp = (ts: number): string => {
    return new Date(ts < 1e12 ? ts * 1000 : ts).toLocaleString();
  };

  const getContextLabel = (result: SearchResult): string => {
    if (result.source === 'meshcore') {
      return t('search.meshcore_label');
    }
    if (result.channel !== undefined && result.channel !== null) {
      const ch = channels.find(c => c.id === result.channel);
      return t('search.channel_label', { name: ch?.name || t('channels.channel_fallback', { channelNum: result.channel }) });
    }
    if (result.toNodeId) {
      const node = nodes.find(n => n.nodeId === result.toNodeId);
      return t('search.dm_label', { name: node?.longName ?? result.toNodeId });
    }
    return '';
  };

  const getSenderName = (result: SearchResult): string => {
    if (result.fromNodeId) {
      const node = nodes.find(n => n.nodeId === result.fromNodeId);
      if (node) return `${node.longName} (${node.shortName})`;
      return result.fromNodeId;
    }
    return '';
  };

  const highlightText = (text: string, searchQuery: string): React.ReactNode[] => {
    if (!searchQuery) return [text];
    const flags = caseSensitive ? 'g' : 'gi';
    const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, flags);
    const parts = text.split(regex);
    return parts.map((part, i) => {
      if (regex.test(part)) {
        // Reset lastIndex since we used 'g' flag
        regex.lastIndex = 0;
        return <mark key={i}>{part}</mark>;
      }
      return <React.Fragment key={i}>{part}</React.Fragment>;
    });
  };

  const handleChannelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (value === '') {
      setSelectedChannels([]);
    } else {
      setSelectedChannels([Number(value)]);
    }
  };

  if (!isOpen) return null;

  const showChannelFilter = scope === 'all' || scope === 'channels';

  return (
    <div className="search-modal-overlay" onClick={onClose}>
      <div className="search-modal" onClick={e => e.stopPropagation()}>
        <div className="search-modal-header">
          <h2>{t('search.title')}</h2>
          <button className="search-modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="search-modal-body">
          <form onSubmit={handleSubmit}>
            <div className="search-input-row">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('search.placeholder')}
              />
              <button
                type="submit"
                className="search-submit-btn"
                disabled={query.length < 2 || loading}
              >
                {t('search.button')}
              </button>
            </div>
          </form>

          <div className="search-filters">
            <label className="search-case-toggle">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={e => setCaseSensitive(e.target.checked)}
              />
              {t('search.case_sensitive')}
            </label>

            <div className="search-filter-group">
              <label>{t('search.scope')}</label>
              <select
                value={scope}
                onChange={e => setScope(e.target.value as typeof scope)}
              >
                <option value="all">{t('search.scope_all')}</option>
                <option value="channels">{t('search.scope_channels')}</option>
                <option value="dms">{t('search.scope_dms')}</option>
                <option value="meshcore">{t('search.scope_meshcore')}</option>
              </select>
            </div>

            {showChannelFilter && channels.length > 0 && (
              <div className="search-filter-group">
                <label>{t('search.channels_filter')}</label>
                <select
                  value={selectedChannels[0] ?? ''}
                  onChange={handleChannelChange}
                >
                  <option value="">{t('search.scope_all')}</option>
                  {channels.map(ch => (
                    <option key={ch.id} value={ch.id}>{ch.name || t('channels.channel_fallback', { channelNum: ch.id })}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="search-filter-group">
              <label>{t('search.sender_filter')}</label>
              <select
                value={senderNodeId}
                onChange={e => setSenderNodeId(e.target.value)}
              >
                <option value="">{t('search.scope_all')}</option>
                {nodes.map(node => (
                  <option key={node.nodeId} value={node.nodeId}>
                    {node.longName} ({node.shortName})
                  </option>
                ))}
              </select>
            </div>

            <div className="search-filter-group">
              <label>{t('search.date_from')}</label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
              />
            </div>

            <div className="search-filter-group">
              <label>{t('search.date_to')}</label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
              />
            </div>
          </div>

          {loading && (
            <div className="search-loading">{t('search.loading')}</div>
          )}

          {error && (
            <div className="search-error">{t('search.error')}</div>
          )}

          {!loading && !error && hasSearched && results.length === 0 && (
            <div className="search-no-results">{t('search.no_results')}</div>
          )}

          {!loading && !error && results.length > 0 && (
            <>
              <div className="search-results-header">
                {results.length < total
                  ? t('search.results_count_of', { count: results.length, total })
                  : t('search.results_count', { count: results.length })}
              </div>
              <div className="search-results-list">
                {results.map(result => (
                  <div
                    key={result.id}
                    className="search-result-item"
                    onClick={() => handleResultClick(result)}
                  >
                    <div className="search-result-meta">
                      <span className="search-result-context">
                        {getContextLabel(result)}
                      </span>
                      <span className="search-result-sender">
                        {getSenderName(result)}
                      </span>
                      <span className="search-result-time">
                        {formatTimestamp(result.timestamp)}
                      </span>
                    </div>
                    <div className="search-result-text">
                      {highlightText(result.text, query)}
                    </div>
                  </div>
                ))}
              </div>
              {results.length < total && (
                <div className="search-load-more">
                  <button
                    className="search-load-more-btn"
                    onClick={handleLoadMore}
                    disabled={loading}
                  >
                    {t('search.load_more')}
                  </button>
                </div>
              )}
            </>
          )}

          {!hasSearched && !loading && query.length < 2 && (
            <div className="search-min-length">{t('search.min_length')}</div>
          )}
        </div>
      </div>
    </div>
  );
};
