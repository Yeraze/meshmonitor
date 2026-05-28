import React, { useState, useEffect, useCallback } from 'react';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSourceQuery } from '../hooks/useSourceQuery';
import { useSaveBar } from '../hooks/useSaveBar';
import type { Channel } from '../types/device';

interface AutoBotSectionProps {
  channels: Channel[];
  baseUrl: string;
}

type BotProvider = 'openai' | 'ollama' | 'openrouter';

interface BotSettings {
  enabled: boolean;
  provider: BotProvider;
  apiKey: string;
  apiUrl: string;
  model: string;
  systemPrompt: string;
  maxTokens: number;
  maxChars: number;
  temperature: number;
  triggerWord: string;
  listenChannels: number[];
  listenDM: boolean;
  cooldownSeconds: number;
  skipIncompleteNodes: boolean;
  contextMessages: number;
  appendNodeInfo: boolean;
}

const DEFAULT_SETTINGS: BotSettings = {
  enabled: false,
  provider: 'openai',
  apiKey: '',
  apiUrl: '',
  model: 'gpt-4o-mini',
  systemPrompt: 'You are a helpful assistant on a Meshtastic mesh radio network. Keep responses very short (under 200 chars). The user is {LONG_NAME} ({SHORT_NAME}).',
  maxTokens: 150,
  maxChars: 200,
  temperature: 0.7,
  triggerWord: 'bot',
  listenChannels: [0],
  listenDM: true,
  cooldownSeconds: 30,
  skipIncompleteNodes: false,
  contextMessages: 3,
  appendNodeInfo: true,
};

const PROVIDER_PRESETS: Record<BotProvider, { label: string; defaultUrl: string; defaultModel: string; placeholder: string }> = {
  openai: {
    label: 'OpenAI',
    defaultUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    placeholder: 'sk-...',
  },
  ollama: {
    label: 'Ollama (local)',
    defaultUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    placeholder: 'ollama (no key needed)',
  },
  openrouter: {
    label: 'OpenRouter',
    defaultUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'google/gemini-flash-1.5',
    placeholder: 'sk-or-...',
  },
};

const AutoBotSection: React.FC<AutoBotSectionProps> = ({ channels, baseUrl }) => {
  const csrfFetch = useCsrfFetch();
  const sourceQuery = useSourceQuery();
  const { showToast } = useToast();

  const [local, setLocal] = useState<BotSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState<BotSettings>(DEFAULT_SETTINGS);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Test chat state
  const [testInput, setTestInput] = useState('');
  const [testResult, setTestResult] = useState<{ response?: string; error?: string; ms?: number } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Load settings
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${baseUrl}/api/settings${sourceQuery}`);
        if (!res.ok) return;
        const s = await res.json();
        const bool = (k: string, d: boolean) => s[k] !== undefined ? (s[k] === 'true' || s[k] === true) : d;
        const num = (k: string, d: number) => { const v = parseFloat(s[k]); return isNaN(v) ? d : v; };
        const arr = (k: string, d: number[]) => {
          if (!s[k]) return d;
          try { return JSON.parse(s[k]); } catch { return d; }
        };

        const loaded: BotSettings = {
          enabled: bool('botEnabled', false),
          provider: (s.botProvider as BotProvider) || 'openai',
          apiKey: s.botApiKey || '',
          apiUrl: s.botApiUrl || '',
          model: s.botModel || 'gpt-4o-mini',
          systemPrompt: s.botSystemPrompt || DEFAULT_SETTINGS.systemPrompt,
          maxTokens: num('botMaxTokens', 150),
          maxChars: num('botMaxChars', 200),
          temperature: num('botTemperature', 0.7),
          triggerWord: s.botTriggerWord || 'bot',
          listenChannels: arr('botListenChannels', [0]),
          listenDM: bool('botListenDM', true),
          cooldownSeconds: num('botCooldownSeconds', 30),
          skipIncompleteNodes: bool('botSkipIncompleteNodes', false),
          contextMessages: num('botContextMessages', 3),
          appendNodeInfo: bool('botAppendNodeInfo', true),
        };
        setLocal(loaded);
        setSaved(loaded);
      } catch (e) {
        console.error('[AutoBotSection] load error:', e);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [baseUrl, sourceQuery]);

  useEffect(() => {
    setHasChanges(JSON.stringify(local) !== JSON.stringify(saved));
  }, [local, saved]);

  const update = <K extends keyof BotSettings>(key: K, value: BotSettings[K]) => {
    setLocal(prev => ({ ...prev, [key]: value }));
  };

  const handleProviderChange = (provider: BotProvider) => {
    const preset = PROVIDER_PRESETS[provider];
    setLocal(prev => ({
      ...prev,
      provider,
      apiUrl: preset.defaultUrl,
      model: preset.defaultModel,
    }));
  };

  const resetChanges = useCallback(() => {
    setLocal(saved);
  }, [saved]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const body = {
        botEnabled: String(local.enabled),
        botProvider: local.provider,
        botApiKey: local.apiKey,
        botApiUrl: local.apiUrl,
        botModel: local.model,
        botSystemPrompt: local.systemPrompt,
        botMaxTokens: local.maxTokens,
        botMaxChars: local.maxChars,
        botTemperature: local.temperature,
        botTriggerWord: local.triggerWord,
        botListenChannels: JSON.stringify(local.listenChannels),
        botListenDM: String(local.listenDM),
        botCooldownSeconds: local.cooldownSeconds,
        botSkipIncompleteNodes: String(local.skipIncompleteNodes),
        botContextMessages: local.contextMessages,
        botAppendNodeInfo: String(local.appendNodeInfo),
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
      showToast('Bot settings saved', 'success');
    } catch (e: any) {
      showToast(e.message || 'Failed to save bot settings', 'error');
    } finally {
      setIsSaving(false);
    }
  }, [local, baseUrl, csrfFetch, sourceQuery, showToast]);

  useSaveBar({ id: 'auto-bot', sectionName: 'AI Bot', hasChanges, isSaving, onSave: handleSave, onDismiss: resetChanges });

  const handleTest = async () => {
    if (!testInput.trim()) return;
    setIsTesting(true);
    setTestResult(null);
    const t0 = Date.now();
    try {
      const res = await csrfFetch(`${baseUrl}/api/bot/test${sourceQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: testInput,
          provider: local.provider,
          apiKey: local.apiKey,
          apiUrl: local.apiUrl,
          model: local.model,
          systemPrompt: local.systemPrompt,
          maxTokens: local.maxTokens,
          maxChars: local.maxChars,
          temperature: local.temperature,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTestResult({ error: data.error || `HTTP ${res.status}` });
      } else {
        setTestResult({ response: data.response, ms: Date.now() - t0 });
      }
    } catch (e: any) {
      setTestResult({ error: e.message });
    } finally {
      setIsTesting(false);
    }
  };

  const toggleChannel = (id: number) => {
    setLocal(prev => ({
      ...prev,
      listenChannels: prev.listenChannels.includes(id)
        ? prev.listenChannels.filter(c => c !== id)
        : [...prev.listenChannels, id],
    }));
  };

  if (isLoading) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--ctp-subtext0)' }}>Loading bot settings…</div>;
  }

  const preset = PROVIDER_PRESETS[local.provider];

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

  const badge = (color: string, text: string) => (
    <span style={{
      padding: '0.15rem 0.5rem', borderRadius: '999px',
      fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.05em',
      background: color, color: '#fff', marginLeft: '0.5rem',
    }}>{text}</span>
  );

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
          🤖 AI Bot
          {badge('#7c3aed', 'NEW')}
          {local.enabled && badge('#16a34a', 'ACTIVE')}
        </h2>
        <div style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
          Meshtastic AI assistant • {preset.label} • {local.model}
        </div>
      </div>

      <div style={{ opacity: local.enabled ? 1 : 0.55, transition: 'opacity 0.2s' }}>

        {/* Description */}
        <p style={{ marginBottom: '1.25rem', color: 'var(--ctp-subtext0)', lineHeight: 1.6, fontSize: '0.9rem' }}>
          AI-powered bot that listens to messages on Meshtastic channels and replies using a language model.
          Triggered by a keyword, replies via DM or channel. Supports OpenAI, Ollama (local), and OpenRouter.
        </p>

        {/* Provider */}
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: '0.75rem', fontSize: '0.95rem' }}>Provider & Model</div>
          <div style={row}>
            <div style={col}>
              <label style={label}>Provider</label>
              <select
                value={local.provider}
                onChange={e => handleProviderChange(e.target.value as BotProvider)}
                disabled={!local.enabled}
                style={input}
              >
                {(Object.keys(PROVIDER_PRESETS) as BotProvider[]).map(p => (
                  <option key={p} value={p}>{PROVIDER_PRESETS[p].label}</option>
                ))}
              </select>
            </div>
            <div style={col}>
              <label style={label}>Model</label>
              <input
                type="text"
                value={local.model}
                onChange={e => update('model', e.target.value)}
                disabled={!local.enabled}
                style={input}
                placeholder={preset.defaultModel}
              />
            </div>
          </div>

          <div style={{ marginTop: '0.75rem' }}>
            <label style={label}>API URL</label>
            <input
              type="text"
              value={local.apiUrl || preset.defaultUrl}
              onChange={e => update('apiUrl', e.target.value)}
              disabled={!local.enabled}
              style={{ ...input, fontFamily: 'monospace' }}
              placeholder={preset.defaultUrl}
            />
            <div style={desc}>Leave default for standard endpoints. Change for custom proxies.</div>
          </div>

          <div style={{ marginTop: '0.75rem' }}>
            <label style={label}>API Key</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                type={showApiKey ? 'text' : 'password'}
                value={local.apiKey}
                onChange={e => update('apiKey', e.target.value)}
                disabled={!local.enabled}
                style={{ ...input, flex: 1, fontFamily: 'monospace' }}
                placeholder={preset.placeholder}
              />
              <button
                type="button"
                onClick={() => setShowApiKey(v => !v)}
                style={{
                  padding: '0.5rem 0.75rem', borderRadius: '6px', cursor: 'pointer',
                  background: 'var(--ctp-surface2)', border: '1px solid var(--ctp-overlay0)',
                  color: 'var(--ctp-text)', fontSize: '0.85rem',
                }}
              >
                {showApiKey ? '🙈 Hide' : '👁 Show'}
              </button>
            </div>
            {local.provider === 'ollama' && (
              <div style={{ ...desc, color: 'var(--ctp-green)', marginTop: '0.3rem' }}>
                Ollama runs locally — no API key needed
              </div>
            )}
          </div>
        </div>

        {/* Trigger & Channels */}
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: '0.75rem', fontSize: '0.95rem' }}>Trigger & Channels</div>
          <div style={row}>
            <div style={col}>
              <label style={label}>Trigger Word</label>
              <input
                type="text"
                value={local.triggerWord}
                onChange={e => update('triggerWord', e.target.value)}
                disabled={!local.enabled}
                style={{ ...input, fontFamily: 'monospace' }}
                placeholder="bot"
              />
              <div style={desc}>
                Message must start with this word. E.g. "<strong>{local.triggerWord || 'bot'}</strong> what's the weather?"
              </div>
            </div>
            <div style={col}>
              <label style={label}>Cooldown (seconds)</label>
              <input
                type="number"
                min={0}
                value={local.cooldownSeconds}
                onChange={e => update('cooldownSeconds', Math.max(0, parseInt(e.target.value) || 0))}
                disabled={!local.enabled}
                style={input}
              />
              <div style={desc}>Min time between replies per node (0 = no cooldown)</div>
            </div>
          </div>

          <div style={{ marginTop: '0.75rem' }}>
            <label style={label}>Listen on Channels</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.25rem' }}>
              {channels.map(ch => (
                <label key={ch.id} style={{
                  display: 'flex', alignItems: 'center', gap: '0.4rem',
                  padding: '0.3rem 0.7rem', borderRadius: '6px', cursor: local.enabled ? 'pointer' : 'not-allowed',
                  background: local.listenChannels.includes(ch.id) ? 'var(--ctp-blue)' : 'var(--ctp-surface2)',
                  color: local.listenChannels.includes(ch.id) ? '#fff' : 'var(--ctp-text)',
                  fontSize: '0.85rem', fontWeight: 500,
                  border: '1px solid transparent',
                  transition: 'all 0.15s',
                }}>
                  <input
                    type="checkbox"
                    checked={local.listenChannels.includes(ch.id)}
                    onChange={() => toggleChannel(ch.id)}
                    disabled={!local.enabled}
                    style={{ display: 'none' }}
                  />
                  {ch.name || `Channel ${ch.id}`}
                </label>
              ))}
            </div>
          </div>

          <div style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              id="bot-listen-dm"
              checked={local.listenDM}
              onChange={e => update('listenDM', e.target.checked)}
              disabled={!local.enabled}
              style={{ width: 'auto', margin: 0 }}
            />
            <label htmlFor="bot-listen-dm" style={{ cursor: local.enabled ? 'pointer' : 'not-allowed', fontSize: '0.9rem' }}>
              Listen to Direct Messages (no trigger word required)
            </label>
          </div>

          <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              id="bot-skip-incomplete"
              checked={local.skipIncompleteNodes}
              onChange={e => update('skipIncompleteNodes', e.target.checked)}
              disabled={!local.enabled}
              style={{ width: 'auto', margin: 0 }}
            />
            <label htmlFor="bot-skip-incomplete" style={{ cursor: local.enabled ? 'pointer' : 'not-allowed', fontSize: '0.9rem' }}>
              Skip nodes without a name (ignore unknown nodes)
            </label>
          </div>
        </div>

        {/* System Prompt */}
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: '0.5rem', fontSize: '0.95rem' }}>System Prompt</div>
          <div style={{ ...desc, marginBottom: '0.5rem' }}>
            Available tokens: <code>{'{LONG_NAME}'}</code> <code>{'{SHORT_NAME}'}</code> <code>{'{NODECOUNT}'}</code>
          </div>
          <textarea
            value={local.systemPrompt}
            onChange={e => update('systemPrompt', e.target.value)}
            disabled={!local.enabled}
            rows={5}
            style={{ ...input, fontFamily: 'monospace', resize: 'vertical', minHeight: '100px' }}
          />
          <div style={{ ...desc, marginTop: '0.3rem' }}>
            Tip: tell the bot to keep answers short — Meshtastic packets max ~200 chars.
          </div>
        </div>

        {/* Advanced */}
        <div style={card}>
          <button
            type="button"
            onClick={() => setShowAdvanced(v => !v)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--ctp-blue)', fontWeight: 700, fontSize: '0.9rem',
              display: 'flex', alignItems: 'center', gap: '0.4rem', padding: 0,
            }}
          >
            {showAdvanced ? '▾' : '▸'} Advanced Settings
          </button>

          {showAdvanced && (
            <div style={{ marginTop: '1rem' }}>
              <div style={row}>
                <div style={col}>
                  <label style={label}>Max Tokens (LLM)</label>
                  <input
                    type="number" min={10} max={2048}
                    value={local.maxTokens}
                    onChange={e => update('maxTokens', parseInt(e.target.value) || 150)}
                    disabled={!local.enabled} style={input}
                  />
                  <div style={desc}>How many tokens the model generates</div>
                </div>
                <div style={col}>
                  <label style={label}>Max Response Chars</label>
                  <input
                    type="number" min={10} max={500}
                    value={local.maxChars}
                    onChange={e => update('maxChars', parseInt(e.target.value) || 200)}
                    disabled={!local.enabled} style={input}
                  />
                  <div style={desc}>Response truncated to fit Meshtastic packet</div>
                </div>
                <div style={col}>
                  <label style={label}>Temperature</label>
                  <input
                    type="number" min={0} max={2} step={0.1}
                    value={local.temperature}
                    onChange={e => update('temperature', parseFloat(e.target.value) || 0.7)}
                    disabled={!local.enabled} style={input}
                  />
                  <div style={desc}>0 = deterministic, 1 = creative, 2 = wild</div>
                </div>
                <div style={col}>
                  <label style={label}>Context Messages</label>
                  <input
                    type="number" min={0} max={10}
                    value={local.contextMessages}
                    onChange={e => update('contextMessages', parseInt(e.target.value) || 3)}
                    disabled={!local.enabled} style={input}
                  />
                  <div style={desc}>Previous messages to include for context</div>
                </div>
              </div>
              <div style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  id="bot-append-node"
                  checked={local.appendNodeInfo}
                  onChange={e => update('appendNodeInfo', e.target.checked)}
                  disabled={!local.enabled}
                  style={{ width: 'auto', margin: 0 }}
                />
                <label htmlFor="bot-append-node" style={{ cursor: local.enabled ? 'pointer' : 'not-allowed', fontSize: '0.9rem' }}>
                  Append node info to system prompt (hop count, SNR, battery)
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Live Test */}
        <div style={{ ...card, border: '1px solid var(--ctp-blue)' }}>
          <div style={{ fontWeight: 700, marginBottom: '0.75rem', fontSize: '0.95rem', color: 'var(--ctp-blue)' }}>
            🧪 Live Test
          </div>
          <div style={{ ...desc, marginBottom: '0.75rem' }}>
            Test your bot configuration without sending to the mesh. Uses the saved API key.
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="text"
              value={testInput}
              onChange={e => setTestInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleTest()}
              placeholder={`${local.triggerWord} tell me about Meshtastic`}
              style={{ ...input, flex: 1 }}
            />
            <button
              type="button"
              onClick={handleTest}
              disabled={isTesting || !testInput.trim()}
              style={{
                padding: '0.5rem 1.25rem', borderRadius: '6px', cursor: 'pointer',
                background: 'var(--ctp-blue)', color: '#fff', border: 'none', fontWeight: 600,
                opacity: (isTesting || !testInput.trim()) ? 0.5 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              {isTesting ? '⏳ Testing…' : '▶ Run'}
            </button>
          </div>

          {testResult && (
            <div style={{
              marginTop: '0.75rem', padding: '0.75rem', borderRadius: '6px',
              background: testResult.error ? 'rgba(220,38,38,0.1)' : 'rgba(34,197,94,0.08)',
              border: `1px solid ${testResult.error ? 'var(--ctp-red)' : 'var(--ctp-green)'}`,
            }}>
              {testResult.error ? (
                <div style={{ color: 'var(--ctp-red)', fontFamily: 'monospace', fontSize: '0.9rem' }}>
                  ❌ {testResult.error}
                </div>
              ) : (
                <>
                  <div style={{ fontFamily: 'monospace', fontSize: '0.9rem', lineHeight: 1.5 }}>
                    {testResult.response}
                  </div>
                  <div style={{ ...desc, marginTop: '0.5rem', display: 'flex', gap: '1rem' }}>
                    <span>✅ {testResult.response?.length ?? 0} chars</span>
                    {testResult.ms && <span>⚡ {testResult.ms}ms</span>}
                    {(testResult.response?.length ?? 0) > local.maxChars && (
                      <span style={{ color: 'var(--ctp-yellow)' }}>
                        ⚠️ Will be truncated to {local.maxChars} chars on mesh
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* How it works */}
        <div style={{
          padding: '0.75rem 1rem', borderRadius: '6px', fontSize: '0.85rem',
          background: 'var(--ctp-surface0)', border: '1px solid var(--ctp-surface2)',
          color: 'var(--ctp-subtext0)', lineHeight: 1.7,
        }}>
          <strong>How it works:</strong> When a message starts with "<code>{local.triggerWord || 'bot'}</code> ",
          MeshMonitor sends it to <strong>{preset.label}</strong> using model <strong>{local.model}</strong>,
          then replies via DM to the sender. Responses are capped at <strong>{local.maxChars} chars</strong>.
          {local.listenDM && ' DMs are answered without trigger word.'}
        </div>

      </div>
    </>
  );
};

export default AutoBotSection;
