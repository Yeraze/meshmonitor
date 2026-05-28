import React, { useState, useEffect, useCallback } from 'react';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSourceQuery } from '../hooks/useSourceQuery';
import { useSaveBar } from '../hooks/useSaveBar';

interface TelegramSectionProps {
  baseUrl: string;
}

interface TelegramSettings {
  enabled: boolean;
  botToken: string;
  chatId: string;
  adminUserIds: string;
  bridgeChannelIndex: number;
  bridgeSourceId: string;
  forwardMessages: boolean;
  forwardDMs: boolean;
  notifyNewNodes: boolean;
  notifyInactive: boolean;
  prefix: string;
}

const DEFAULT: TelegramSettings = {
  enabled: false,
  botToken: '',
  chatId: '',
  adminUserIds: '',
  bridgeChannelIndex: 0,
  bridgeSourceId: '',
  forwardMessages: true,
  forwardDMs: false,
  notifyNewNodes: true,
  notifyInactive: false,
  prefix: '[TG] ',
};

const TelegramSection: React.FC<TelegramSectionProps> = ({ baseUrl }) => {
  const csrfFetch = useCsrfFetch();
  const sourceQuery = useSourceQuery();
  const { showToast } = useToast();

  const [local, setLocal] = useState<TelegramSettings>(DEFAULT);
  const [saved, setSaved] = useState<TelegramSettings>(DEFAULT);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [showToken, setShowToken] = useState(false);

  // Test state
  const [testingToken, setTestingToken] = useState(false);
  const [testingMsg, setTestingMsg] = useState(false);
  const [tokenResult, setTokenResult] = useState<{ ok: boolean; username?: string; error?: string } | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${baseUrl}/api/settings${sourceQuery}`);
        if (!res.ok) return;
        const s = await res.json();
        const bool = (k: string, d: boolean) =>
          s[k] !== undefined ? (s[k] === 'true' || s[k] === true) : d;
        const num = (k: string, d: number) => { const v = parseInt(s[k]); return isNaN(v) ? d : v; };

        const loaded: TelegramSettings = {
          enabled: bool('telegramEnabled', false),
          botToken: s.telegramBotToken ?? '',
          chatId: s.telegramChatId ?? '',
          adminUserIds: s.telegramAdminUserIds ?? '',
          bridgeChannelIndex: num('telegramBridgeChannelIndex', 0),
          bridgeSourceId: s.telegramBridgeSourceId ?? '',
          forwardMessages: bool('telegramForwardMessages', true),
          forwardDMs: bool('telegramForwardDMs', false),
          notifyNewNodes: bool('telegramNotifyNewNodes', true),
          notifyInactive: bool('telegramNotifyInactive', false),
          prefix: s.telegramPrefix ?? '[TG] ',
        };
        setLocal(loaded);
        setSaved(loaded);
      } catch (e) {
        console.error('[TelegramSection] load error:', e);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [baseUrl, sourceQuery]);

  useEffect(() => {
    setHasChanges(JSON.stringify(local) !== JSON.stringify(saved));
  }, [local, saved]);

  const update = <K extends keyof TelegramSettings>(key: K, value: TelegramSettings[K]) =>
    setLocal(prev => ({ ...prev, [key]: value }));

  const resetChanges = useCallback(() => setLocal(saved), [saved]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const body = {
        telegramEnabled: String(local.enabled),
        telegramBotToken: local.botToken,
        telegramChatId: local.chatId,
        telegramAdminUserIds: local.adminUserIds,
        telegramBridgeChannelIndex: local.bridgeChannelIndex,
        telegramBridgeSourceId: local.bridgeSourceId,
        telegramForwardMessages: String(local.forwardMessages),
        telegramForwardDMs: String(local.forwardDMs),
        telegramNotifyNewNodes: String(local.notifyNewNodes),
        telegramNotifyInactive: String(local.notifyInactive),
        telegramPrefix: local.prefix,
      };
      const res = await csrfFetch(`${baseUrl}/api/settings${sourceQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (res.status === 403) { showToast('Permission denied', 'error'); return; }
        throw new Error(`Server returned ${res.status}`);
      }
      setSaved(local);
      setHasChanges(false);
      showToast('Telegram settings saved', 'success');
      // Reload bot settings cache so new config takes effect immediately
      csrfFetch(`${baseUrl}/api/telegram/reload`, { method: 'POST' }).catch(() => {});
    } catch (e: any) {
      showToast(e.message || 'Failed to save', 'error');
    } finally {
      setIsSaving(false);
    }
  }, [local, baseUrl, csrfFetch, sourceQuery, showToast]);

  useSaveBar({ id: 'telegram', sectionName: 'Telegram', hasChanges, isSaving, onSave: handleSave, onDismiss: resetChanges });

  const handleTestToken = async () => {
    if (!local.botToken.trim()) return;
    setTestingToken(true);
    setTokenResult(null);
    try {
      const res = await csrfFetch(`${baseUrl}/api/telegram/test-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: local.botToken }),
      });
      const data = await res.json();
      setTokenResult(data);
    } catch (e: any) {
      setTokenResult({ ok: false, error: e.message });
    } finally {
      setTestingToken(false);
    }
  };

  const handleTestMessage = async () => {
    if (!local.botToken.trim() || !local.chatId.trim()) {
      showToast('Enter Bot Token and Chat ID first', 'warning');
      return;
    }
    setTestingMsg(true);
    try {
      const res = await csrfFetch(`${baseUrl}/api/telegram/test-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: local.botToken, chatId: local.chatId }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast('Test message sent to Telegram!', 'success');
      } else {
        showToast(data.error ?? 'Failed to send', 'error');
      }
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setTestingMsg(false);
    }
  };

  if (isLoading) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--ctp-subtext0)' }}>Loading…</div>;
  }

  // ── Styles ──────────────────────────────────────────────────────────────────
  const sectionHeader: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: '1.5rem', padding: '1rem 1.25rem',
    background: 'var(--ctp-surface1)', border: '1px solid var(--ctp-surface2)',
    borderRadius: '8px',
  };
  const card: React.CSSProperties = {
    background: 'var(--ctp-surface0)', border: '1px solid var(--ctp-surface2)',
    borderRadius: '8px', padding: '1rem 1.25rem', marginBottom: '1rem',
  };
  const label: React.CSSProperties = {
    display: 'block', fontWeight: 600, marginBottom: '0.4rem', fontSize: '0.9rem',
  };
  const desc: React.CSSProperties = {
    fontSize: '0.8rem', color: 'var(--ctp-subtext0)', marginTop: '0.2rem',
  };
  const input: React.CSSProperties = {
    width: '100%', padding: '0.5rem 0.75rem',
    background: 'var(--ctp-surface1)', border: '1px solid var(--ctp-overlay0)',
    borderRadius: '6px', color: 'var(--ctp-text)', fontSize: '0.9rem',
  };
  const row: React.CSSProperties = { display: 'flex', gap: '1rem', flexWrap: 'wrap' };
  const col: React.CSSProperties = { flex: '1', minWidth: '200px' };
  const checkRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' };

  const badge = (color: string, text: string) => (
    <span style={{
      padding: '0.15rem 0.5rem', borderRadius: '999px',
      fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.05em',
      background: color, color: '#fff', marginLeft: '0.5rem',
    }}>{text}</span>
  );

  const btnStyle = (color: string, disabled = false): React.CSSProperties => ({
    padding: '0.45rem 1rem', borderRadius: '6px', cursor: disabled ? 'not-allowed' : 'pointer',
    background: color, color: '#fff', border: 'none', fontWeight: 600, fontSize: '0.85rem',
    opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
  });

  return (
    <>
      {/* Header */}
      <div style={sectionHeader}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '1.15rem' }}>
          <input
            type="checkbox"
            checked={local.enabled}
            onChange={e => update('enabled', e.target.checked)}
            style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
          />
          ✈️ Telegram Integration
          {badge('#0088cc', 'NATIVE')}
          {local.enabled && badge('#16a34a', 'ACTIVE')}
        </h2>
        <div style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
          Bidirectional mesh ↔ Telegram bridge
        </div>
      </div>

      <div style={{ opacity: local.enabled ? 1 : 0.55, transition: 'opacity 0.2s' }}>

        <p style={{ marginBottom: '1.25rem', color: 'var(--ctp-subtext0)', lineHeight: 1.6, fontSize: '0.9rem' }}>
          Bridge your Meshtastic mesh to a Telegram chat. Mesh messages are forwarded to Telegram,
          and admins can reply directly from Telegram to the mesh.
          Uses long polling — no public URL or webhook setup needed.
        </p>

        {/* Bot Token */}
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: '0.75rem', fontSize: '0.95rem' }}>Bot Configuration</div>

          <div style={{ marginBottom: '0.75rem' }}>
            <label style={label}>Bot Token</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                type={showToken ? 'text' : 'password'}
                value={local.botToken}
                onChange={e => { update('botToken', e.target.value); setTokenResult(null); }}
                disabled={!local.enabled}
                style={{ ...input, flex: 1, fontFamily: 'monospace' }}
                placeholder="1234567890:AAF..."
              />
              <button type="button" onClick={() => setShowToken(v => !v)}
                style={btnStyle('var(--ctp-surface2)')}>
                {showToken ? '🙈' : '👁'}
              </button>
              <button type="button" onClick={handleTestToken}
                disabled={testingToken || !local.botToken.trim()}
                style={btnStyle('var(--ctp-blue)', testingToken || !local.botToken.trim())}>
                {testingToken ? '⏳' : '✔ Verify'}
              </button>
            </div>
            {tokenResult && (
              <div style={{ marginTop: '0.4rem', fontSize: '0.85rem',
                color: tokenResult.ok ? 'var(--ctp-green)' : 'var(--ctp-red)' }}>
                {tokenResult.ok
                  ? `✅ Connected as @${tokenResult.username}`
                  : `❌ ${tokenResult.error}`}
              </div>
            )}
            <div style={desc}>
              Create a bot via <strong>@BotFather</strong> on Telegram, then paste the token here.
            </div>
          </div>

          <div style={row}>
            <div style={col}>
              <label style={label}>Chat ID</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="text"
                  value={local.chatId}
                  onChange={e => update('chatId', e.target.value)}
                  disabled={!local.enabled}
                  style={{ ...input, fontFamily: 'monospace' }}
                  placeholder="-1001234567890"
                />
              </div>
              <div style={desc}>
                Group/channel ID. Add the bot to a group, send a message, then check
                {' '}<code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> to find it.
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: '0.25rem' }}>
              <button type="button" onClick={handleTestMessage}
                disabled={testingMsg || !local.botToken.trim() || !local.chatId.trim()}
                style={btnStyle('var(--ctp-green)',
                  testingMsg || !local.botToken.trim() || !local.chatId.trim())}>
                {testingMsg ? '⏳ Sending…' : '📨 Send Test'}
              </button>
            </div>
          </div>
        </div>

        {/* Bridge settings */}
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: '0.75rem', fontSize: '0.95rem' }}>Forwarding & Bridge</div>

          <div style={row}>
            <div style={col}>
              <label style={label}>Mesh Channel Index</label>
              <input
                type="number" min={0} max={7}
                value={local.bridgeChannelIndex}
                onChange={e => update('bridgeChannelIndex', parseInt(e.target.value) || 0)}
                disabled={!local.enabled}
                style={input}
              />
              <div style={desc}>Channel index for Telegram→mesh messages (0 = Primary)</div>
            </div>
            <div style={col}>
              <label style={label}>Message Prefix (Telegram→mesh)</label>
              <input
                type="text"
                value={local.prefix}
                onChange={e => update('prefix', e.target.value)}
                disabled={!local.enabled}
                style={{ ...input, fontFamily: 'monospace' }}
                placeholder="[TG] "
              />
              <div style={desc}>Prepended to messages sent from Telegram to mesh</div>
            </div>
          </div>

          <div style={{ marginTop: '0.75rem' }}>
            <div style={checkRow}>
              <input type="checkbox" id="tg-fwd-msg" checked={local.forwardMessages}
                onChange={e => update('forwardMessages', e.target.checked)} disabled={!local.enabled}
                style={{ width: 'auto', margin: 0 }} />
              <label htmlFor="tg-fwd-msg" style={{ fontSize: '0.9rem', cursor: local.enabled ? 'pointer' : 'default' }}>
                Forward mesh channel messages → Telegram
              </label>
            </div>
            <div style={checkRow}>
              <input type="checkbox" id="tg-fwd-dm" checked={local.forwardDMs}
                onChange={e => update('forwardDMs', e.target.checked)} disabled={!local.enabled}
                style={{ width: 'auto', margin: 0 }} />
              <label htmlFor="tg-fwd-dm" style={{ fontSize: '0.9rem', cursor: local.enabled ? 'pointer' : 'default' }}>
                Forward mesh DMs → Telegram
              </label>
            </div>
          </div>
        </div>

        {/* Notifications */}
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: '0.75rem', fontSize: '0.95rem' }}>Notifications</div>
          <div style={checkRow}>
            <input type="checkbox" id="tg-new-node" checked={local.notifyNewNodes}
              onChange={e => update('notifyNewNodes', e.target.checked)} disabled={!local.enabled}
              style={{ width: 'auto', margin: 0 }} />
            <label htmlFor="tg-new-node" style={{ fontSize: '0.9rem', cursor: local.enabled ? 'pointer' : 'default' }}>
              Notify on new node discovered
            </label>
          </div>
          <div style={checkRow}>
            <input type="checkbox" id="tg-inactive" checked={local.notifyInactive}
              onChange={e => update('notifyInactive', e.target.checked)} disabled={!local.enabled}
              style={{ width: 'auto', margin: 0 }} />
            <label htmlFor="tg-inactive" style={{ fontSize: '0.9rem', cursor: local.enabled ? 'pointer' : 'default' }}>
              Notify on node going inactive
            </label>
          </div>
        </div>

        {/* Access control */}
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: '0.75rem', fontSize: '0.95rem' }}>Access Control</div>
          <label style={label}>Admin Telegram User IDs</label>
          <input
            type="text"
            value={local.adminUserIds}
            onChange={e => update('adminUserIds', e.target.value)}
            disabled={!local.enabled}
            style={{ ...input, fontFamily: 'monospace' }}
            placeholder="123456789, 987654321"
          />
          <div style={desc}>
            Comma-separated Telegram user IDs allowed to send messages to the mesh.
            Leave empty to allow everyone in the chat (not recommended for public groups).
            Find your ID via <strong>@userinfobot</strong>.
          </div>
        </div>

        {/* Commands reference */}
        <div style={{
          padding: '0.75rem 1rem', borderRadius: '6px', fontSize: '0.85rem',
          background: 'var(--ctp-surface0)', border: '1px solid var(--ctp-surface2)',
          color: 'var(--ctp-subtext0)', lineHeight: 1.8,
        }}>
          <strong>Available Telegram commands:</strong><br />
          <code>/help</code> — show commands &nbsp;
          <code>/status</code> — connection status &nbsp;
          <code>/nodes</code> — active nodes list<br />
          <code>/send [ch] &lt;message&gt;</code> — send to mesh (admins only)<br />
          Plain text from admins is automatically forwarded to mesh channel {local.bridgeChannelIndex}.
        </div>

      </div>
    </>
  );
};

export default TelegramSection;
