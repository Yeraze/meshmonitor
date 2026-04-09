/**
 * Unified Messages Page
 *
 * Combines messages from all sources the user has read access to,
 * sorted newest-first. Each message is tagged with its source name.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { appBasename } from '../init';
import '../styles/unified.css';

interface UnifiedMessage {
  id: string;
  sourceId: string;
  sourceName: string;
  fromId?: string;
  text?: string;
  channel: number;
  timestamp: number;
  fromShortName?: string;
  fromLongName?: string;
}

const SOURCE_COLORS = [
  'var(--ctp-blue)', 'var(--ctp-mauve)', 'var(--ctp-green)',
  'var(--ctp-red)', 'var(--ctp-yellow)', 'var(--ctp-teal)',
];

function getSourceColor(sourceId: string, sourceIds: string[]): string {
  const idx = sourceIds.indexOf(sourceId);
  return SOURCE_COLORS[idx % SOURCE_COLORS.length];
}

function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString();
}

export default function UnifiedMessagesPage() {
  const navigate = useNavigate();
  const { authStatus } = useAuth();
  const isAuthenticated = authStatus?.authenticated ?? false;

  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch(`${appBasename}/api/unified/messages?limit=100`, {
        credentials: 'include',
      });
      if (!res.ok) { setError('Failed to load messages'); return; }
      const data: UnifiedMessage[] = await res.json();
      setMessages(data);
      setError('');
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMessages();
    const interval = setInterval(fetchMessages, 10000);
    return () => clearInterval(interval);
  }, [fetchMessages]);

  const sourceIds = Array.from(new Set(messages.map(m => m.sourceId)));
  let lastDate = '';

  return (
    <div className="unified-page">
      <div className="unified-header">
        <button className="unified-header__back" onClick={() => navigate('/')}>← Sources</button>
        <div className="unified-header__title">
          <h1>Unified Messages</h1>
          <p>All sources combined · newest first</p>
        </div>
        <div className="unified-source-legend">
          {sourceIds.map(sid => {
            const name = messages.find(m => m.sourceId === sid)?.sourceName ?? sid;
            const color = getSourceColor(sid, sourceIds);
            return (
              <span
                key={sid}
                className="unified-source-pill"
                style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color, border: `1px solid color-mix(in srgb, ${color} 35%, transparent)` }}
              >
                {name}
              </span>
            );
          })}
        </div>
      </div>

      <div className="unified-body">
        {loading && <div className="unified-empty">Loading messages…</div>}
        {error && <div className="unified-error">{error}</div>}

        {!loading && !error && messages.length === 0 && (
          <div className="unified-empty">
            {isAuthenticated
              ? 'No messages found across your accessible sources.'
              : 'Sign in to view messages.'}
          </div>
        )}

        {messages.map((msg) => {
          const dateLabel = formatDate(msg.timestamp);
          const showDivider = dateLabel !== lastDate;
          if (showDivider) lastDate = dateLabel;
          const color = getSourceColor(msg.sourceId, sourceIds);
          const sender = msg.fromLongName || msg.fromShortName || msg.fromId || 'Unknown';
          const channelLabel = msg.channel === -1 ? 'DM' : `Ch${msg.channel}`;

          return (
            <div key={msg.id}>
              {showDivider && (
                <div className="unified-date-divider">
                  <span>{dateLabel}</span>
                </div>
              )}
              <div
                className="unified-msg-card"
                style={{ borderLeftColor: color }}
              >
                <div className="unified-msg-card__meta">
                  <span
                    className="unified-msg-card__source-tag"
                    style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color }}
                  >
                    {msg.sourceName}
                  </span>
                  <span className="unified-msg-card__channel">{channelLabel}</span>
                  <span className="unified-msg-card__sender">{sender}</span>
                  <span className="unified-msg-card__time">{formatTime(msg.timestamp)}</span>
                </div>
                <div className="unified-msg-card__text">
                  {msg.text || <em style={{ opacity: 0.4 }}>(no text)</em>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
