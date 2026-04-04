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
  '#2563eb', '#7c3aed', '#059669', '#dc2626', '#d97706', '#0891b2',
];

function getSourceColor(sourceId: string, sourceIds: string[]): string {
  const idx = sourceIds.indexOf(sourceId);
  return SOURCE_COLORS[idx % SOURCE_COLORS.length];
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
      if (!res.ok) {
        setError('Failed to load messages');
        return;
      }
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

  // Group messages by date
  let lastDate = '';

  return (
    <div style={{ minHeight: '100vh', background: '#111', color: '#eee', fontFamily: 'sans-serif' }}>
      {/* Header */}
      <div style={{
        background: '#1a1a1a', borderBottom: '1px solid #333',
        padding: '16px 24px', display: 'flex', alignItems: 'center', gap: 16,
      }}>
        <button
          onClick={() => navigate('/')}
          style={{
            background: '#333', color: '#aaa', border: 'none', borderRadius: 8,
            padding: '8px 16px', fontSize: 13, cursor: 'pointer',
          }}
        >
          ← Sources
        </button>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#fff' }}>Unified Messages</h1>
          <p style={{ margin: 0, fontSize: 12, color: '#666' }}>All sources combined · newest first</p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {sourceIds.map(sid => {
            const name = messages.find(m => m.sourceId === sid)?.sourceName ?? sid;
            return (
              <span
                key={sid}
                style={{
                  background: getSourceColor(sid, sourceIds) + '22',
                  border: `1px solid ${getSourceColor(sid, sourceIds)}44`,
                  color: getSourceColor(sid, sourceIds),
                  borderRadius: 99, padding: '3px 10px', fontSize: 12, fontWeight: 600,
                }}
              >
                {name}
              </span>
            );
          })}
        </div>
      </div>

      {/* Body */}
      <div style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: 64, color: '#666' }}>Loading messages…</div>
        )}

        {error && (
          <div style={{ textAlign: 'center', padding: 32, color: '#ef4444' }}>{error}</div>
        )}

        {!loading && !error && messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: 64, color: '#666' }}>
            {isAuthenticated
              ? 'No messages found across your accessible sources.'
              : 'Sign in to view messages.'}
          </div>
        )}

        {messages.map((msg) => {
          const dateLabel = formatDate(msg.timestamp);
          const showDateDivider = dateLabel !== lastDate;
          if (showDateDivider) lastDate = dateLabel;
          const color = getSourceColor(msg.sourceId, sourceIds);
          const sender = msg.fromLongName || msg.fromShortName || msg.fromId || 'Unknown';
          const channelLabel = msg.channel === -1 ? 'DM' : `Ch${msg.channel}`;

          return (
            <div key={msg.id}>
              {showDateDivider && (
                <div style={{
                  textAlign: 'center', margin: '24px 0 12px',
                  fontSize: 12, color: '#555', position: 'relative',
                }}>
                  <span style={{ background: '#111', padding: '0 12px', position: 'relative', zIndex: 1 }}>
                    {dateLabel}
                  </span>
                  <div style={{
                    position: 'absolute', top: '50%', left: 0, right: 0,
                    height: 1, background: '#333', zIndex: 0,
                  }} />
                </div>
              )}
              <div style={{
                background: '#1a1a1a', border: '1px solid #2a2a2a',
                borderLeft: `3px solid ${color}`,
                borderRadius: 8, padding: '12px 16px', marginBottom: 8,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{
                    background: color + '22', color, borderRadius: 4,
                    padding: '2px 6px', fontSize: 11, fontWeight: 600,
                  }}>
                    {msg.sourceName}
                  </span>
                  <span style={{ color: '#888', fontSize: 12 }}>{channelLabel}</span>
                  <span style={{ color: '#555', fontSize: 12 }}>{sender}</span>
                  <span style={{ marginLeft: 'auto', color: '#555', fontSize: 11 }}>
                    {formatTime(msg.timestamp)}
                  </span>
                </div>
                <div style={{ color: '#ddd', fontSize: 14, lineHeight: 1.5, wordBreak: 'break-word' }}>
                  {msg.text || <em style={{ color: '#555' }}>(no text)</em>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
