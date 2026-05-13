import React, { useEffect, useRef, useState, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { MeshCoreMessage } from './hooks/useMeshCore';

interface MeshCoreMessageStreamProps {
  messages: MeshCoreMessage[];
  selfPublicKey?: string;
  emptyText?: string;
  disabled?: boolean;
  onSend: (text: string) => Promise<boolean>;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

export const MeshCoreMessageStream: React.FC<MeshCoreMessageStreamProps> = ({
  messages,
  selfPublicKey,
  emptyText,
  disabled,
  onSend,
}) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages.length]);

  const handleSend = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    const ok = await onSend(draft);
    setSending(false);
    if (ok) setDraft('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="meshcore-message-stream">
      <div className="meshcore-message-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="meshcore-empty-state">
            {emptyText ?? t('meshcore.no_messages', 'No messages')}
          </div>
        ) : messages.map(m => {
          const outgoing = !!selfPublicKey && m.fromPublicKey === selfPublicKey;
          return (
            <div key={m.id} className={`mc-message-row ${outgoing ? 'outgoing' : ''}`}>
              <div className="mc-message-header">
                <span className="mc-message-from">
                  {outgoing ? t('meshcore.you', 'You') : `${m.fromPublicKey.substring(0, 8)}…`}
                </span>
                <span className="mc-message-time">{formatTime(m.timestamp)}</span>
              </div>
              <div className="mc-message-text">{m.text}</div>
            </div>
          );
        })}
      </div>
      <div className="meshcore-send-bar">
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('meshcore.type_message', 'Type a message…')}
          disabled={disabled || sending}
          maxLength={230}
        />
        <button
          onClick={() => void handleSend()}
          disabled={disabled || sending || !draft.trim()}
        >
          {sending ? t('meshcore.sending', 'Sending…') : t('meshcore.send', 'Send')}
        </button>
      </div>
    </div>
  );
};
