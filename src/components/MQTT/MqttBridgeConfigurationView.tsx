/**
 * Dedicated Configuration page for an mqtt_bridge source.
 *
 * Surfaced as the "Configuration" tab inside the bridge source view (see
 * App.tsx / Sidebar.tsx). Loads the source config via GET /api/sources/:id,
 * presents the full set of bridge options in roomy collapsible sections, and
 * saves the reassembled config via PUT /api/sources/:id.
 *
 * Centralizes options that previously only lived in the cramped create/edit
 * modal, and adds the per-bridge **publish (uplink) topic filter** (#3294).
 * All config (de)serialization is shared with that modal via
 * `./mqttBridgeConfig` so the two editors can never drift.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { appBasename } from '../../init';
import { logger } from '../../utils/logger';
import { CollapsibleSection } from '../MeshCore/CollapsibleSection';
import BBoxMapEditor, { type BBoxValue } from '../BBoxMapEditor';
import { bboxToFormStrings } from '../../pages/DashboardPage.bboxSeed';
import {
  buildBridgeConfig,
  formFromBridgeConfig,
  emptyBridgeForm,
  BRIDGE_MODES,
  BRIDGE_FORWARDING_MODES,
  type BridgeConfigForm,
  type UplinkTopicMode,
} from './mqttBridgeConfig';

interface SourceSummary {
  id: string;
  name: string;
  type: string;
}

interface MqttBridgeConfigurationViewProps {
  /** Source UUID of the bridge being configured. */
  sourceId: string;
}

const GEO_KEYS = ['minLat', 'maxLat', 'minLng', 'maxLng'] as const;

/** Parse the four geo string fields into a BBoxValue, or null if incomplete. */
function bboxFromForm(g: BridgeConfigForm['geo']): BBoxValue | null {
  if (GEO_KEYS.some((k) => g[k] === '')) return null;
  const nums = {
    minLat: Number(g.minLat),
    maxLat: Number(g.maxLat),
    minLng: Number(g.minLng),
    maxLng: Number(g.maxLng),
  };
  if (Object.values(nums).some((n) => Number.isNaN(n))) return null;
  return nums;
}

const labelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--ctp-subtext0)', marginTop: 4 };

export const MqttBridgeConfigurationView: React.FC<MqttBridgeConfigurationViewProps> = ({
  sourceId,
}) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const csrfFetch = useCsrfFetch();
  const canWrite = hasPermission('sources', 'write');

  const [form, setForm] = useState<BridgeConfigForm>(emptyBridgeForm());
  const [brokers, setBrokers] = useState<SourceSummary[]>([]);
  const [knownChannels, setKnownChannels] = useState<string[]>([]);
  const [customChannel, setCustomChannel] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);

  // Shallow patch helper for the form state.
  const patch = useCallback(
    <K extends keyof BridgeConfigForm>(key: K, value: BridgeConfigForm[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      setSaved(false);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const [srcRes, listRes, chDbRes, srcChRes] = await Promise.all([
          csrfFetch(`${appBasename}/api/sources/${sourceId}`),
          csrfFetch(`${appBasename}/api/sources`),
          // Global decryption channels — auto-populated with every channel name
          // any bridge observes, plus user-added rows. Best source of names.
          csrfFetch(`${appBasename}/api/channel-database`),
          // Per-source channels (sparse for bridges; populated from live traffic).
          csrfFetch(`${appBasename}/api/v1/channels?sourceId=${encodeURIComponent(sourceId)}`),
        ]);
        if (!srcRes.ok) throw new Error(`GET source failed: ${srcRes.status}`);
        const src = await srcRes.json();
        if (cancelled) return;
        setForm(formFromBridgeConfig(src?.config));
        if (listRes.ok) {
          const list: SourceSummary[] = await listRes.json();
          if (!cancelled) setBrokers(list.filter((s) => s.type === 'mqtt_broker'));
        }
        // Channel-name suggestions (best-effort — failures just yield no list).
        const names = new Set<string>();
        const collect = (body: unknown) => {
          const rows = Array.isArray(body)
            ? body
            : ((body as { data?: unknown[]; channels?: unknown[] })?.data ??
               (body as { channels?: unknown[] })?.channels ??
               []);
          for (const r of rows as Array<{ name?: unknown }>) {
            if (typeof r?.name === 'string' && r.name.trim()) names.add(r.name.trim());
          }
        };
        if (chDbRes.ok) collect(await chDbRes.json().catch(() => null));
        if (srcChRes.ok) collect(await srcChRes.json().catch(() => null));
        if (!cancelled) {
          setKnownChannels(Array.from(names).sort((a, b) => a.localeCompare(b)));
        }
      } catch (err) {
        logger.error('Failed to load bridge config:', err);
        if (!cancelled) {
          setLoadError(
            t('mqtt_bridge_config.load_error', 'Failed to load bridge configuration.'),
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId, csrfFetch, t]);

  const handleSave = useCallback(async () => {
    setSaveError('');
    setSaved(false);
    const result = buildBridgeConfig(form, { editing: true });
    if (result.error) {
      setSaveError(t(result.error.key, result.error.fallback));
      return;
    }
    setSaving(true);
    try {
      const res = await csrfFetch(`${appBasename}/api/sources/${sourceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: result.config }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `PUT failed: ${res.status}`);
      }
      const updated = await res.json();
      // Re-hydrate from the server's stored config (clears the password field
      // and reflects any server-side normalization).
      setForm(formFromBridgeConfig(updated?.config));
      setSaved(true);
    } catch (err) {
      logger.error('Failed to save bridge config:', err);
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [form, sourceId, csrfFetch, t]);

  const selectedChannels = form.uplinkChannels ?? [];
  const toggleChannel = (name: string, checked: boolean) => {
    const next = new Set(selectedChannels);
    if (checked) next.add(name);
    else next.delete(name);
    patch('uplinkChannels', Array.from(next));
  };
  const addCustomChannel = () => {
    const name = customChannel.trim();
    if (name && !selectedChannels.includes(name)) {
      patch('uplinkChannels', [...selectedChannels, name]);
    }
    setCustomChannel('');
  };
  // Candidate checkboxes = known channel names ∪ anything already selected
  // (so a saved channel that's no longer "known" still shows, checked).
  const channelOptions = Array.from(new Set([...knownChannels, ...selectedChannels])).sort((a, b) =>
    a.localeCompare(b),
  );

  if (loading) {
    return (
      <div className="mqtt-bridge-config" style={{ padding: 16 }}>
        {t('common.loading', 'Loading…')}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mqtt-bridge-config" style={{ padding: 16, color: 'var(--ctp-red)' }}>
        {loadError}
      </div>
    );
  }

  const attached = !!form.brokerId;

  return (
    <div className="mqtt-bridge-config" style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <h2 style={{ marginTop: 0 }}>
        {t('mqtt_bridge_config.title', 'MQTT Bridge Configuration')}
      </h2>

      {/* --- Connection --- */}
      <CollapsibleSection title={t('mqtt_bridge_config.section_connection', 'Connection')}>
        <label className="dashboard-form-field">
          <span className="dashboard-form-label">
            {t('source.form.mqtt_bridge_broker', 'Parent broker (optional)')}
          </span>
          <select
            className="dashboard-form-input"
            value={form.brokerId}
            disabled={!canWrite}
            onChange={(e) => patch('brokerId', e.target.value)}
          >
            <option value="">
              {t('source.form.mqtt_bridge_broker_none', 'None — standalone client proxy')}
            </option>
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <span style={labelStyle}>
            {t(
              'source.form.mqtt_bridge_broker_help',
              'With a parent broker, the bridge also republishes upstream traffic to local devices and forwards their packets upstream. Without one, it runs as a pure MQTT client — useful for monitoring or as a client-proxy target for a Meshtastic source.',
            )}
          </span>
        </label>
        <label className="dashboard-form-field">
          <span className="dashboard-form-label">{t('source.form.mqtt_upstream_url', 'Upstream URL')}</span>
          <input
            className="dashboard-form-input"
            type="text"
            value={form.url}
            disabled={!canWrite}
            onChange={(e) => patch('url', e.target.value)}
            placeholder="mqtt://mqtt.meshtastic.org:1883"
          />
        </label>
        <label className="dashboard-form-field">
          <span className="dashboard-form-label">{t('source.form.mqtt_username', 'Username')}</span>
          <input
            className="dashboard-form-input"
            type="text"
            value={form.username}
            disabled={!canWrite}
            onChange={(e) => patch('username', e.target.value)}
          />
        </label>
        <label className="dashboard-form-field">
          <span className="dashboard-form-label">{t('source.form.mqtt_password', 'Password')}</span>
          <input
            className="dashboard-form-input"
            type="password"
            value={form.password}
            disabled={!canWrite}
            onChange={(e) => patch('password', e.target.value)}
            placeholder="••••••••"
          />
          <span style={labelStyle}>
            {t('mqtt_bridge_config.password_help', 'Leave blank to keep the stored password.')}
          </span>
        </label>
      </CollapsibleSection>

      {/* --- Forwarding --- */}
      <CollapsibleSection title={t('mqtt_bridge_config.section_forwarding', 'Forwarding')}>
        <label className="dashboard-form-field">
          <span className="dashboard-form-label">{t('source.form.mqtt_bridge_mode', 'Mode')}</span>
          <select
            className="dashboard-form-input"
            value={form.mode}
            disabled={!canWrite}
            onChange={(e) => patch('mode', e.target.value as BridgeConfigForm['mode'])}
          >
            {BRIDGE_MODES.map((m) => (
              <option key={m} value={m}>
                {t(`source.form.mqtt_bridge_mode_${m}`, m)}
              </option>
            ))}
          </select>
          <span style={labelStyle}>
            {t(
              'source.form.mqtt_bridge_mode_help',
              'Use "Publish only" for public servers (e.g. mqtt.meshtastic.org) that reject SUBSCRIBE — avoids permission-denied noise. "Subscribe only" disables uplink forwarding for read-only monitoring.',
            )}
          </span>
        </label>
        <label className="dashboard-form-field">
          <span className="dashboard-form-label">
            {t('source.form.mqtt_bridge_forwarding_mode', 'Upstream identity')}
          </span>
          <select
            className="dashboard-form-input"
            value={form.forwardingMode}
            disabled={!canWrite}
            onChange={(e) =>
              patch('forwardingMode', e.target.value as BridgeConfigForm['forwardingMode'])
            }
          >
            {BRIDGE_FORWARDING_MODES.map((m) => (
              <option key={m} value={m}>
                {t(`source.form.mqtt_bridge_forwarding_${m}`, m)}
              </option>
            ))}
          </select>
          <span style={labelStyle}>
            {t(
              'source.form.mqtt_bridge_forwarding_help',
              'Per-gateway lets each local node publish upstream under its own !<hex> Client ID — required for community brokers that filter CONNECT on Client ID. Switch to Single only if the upstream broker has tight per-username connection caps.',
            )}
          </span>
        </label>
        <label className="dashboard-form-field" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
          <input
            type="checkbox"
            checked={form.ignoreOkToMqtt}
            disabled={!canWrite}
            onChange={(e) => patch('ignoreOkToMqtt', e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            <span className="dashboard-form-label" style={{ display: 'block' }}>
              {t('source.form.mqtt_bridge_ignore_ok_to_mqtt', 'Uplink all packets (ignore ok_to_mqtt bit)')}
            </span>
            <span style={{ fontSize: 11, color: 'var(--ctp-yellow)' }}>
              {t(
                'source.form.mqtt_bridge_ignore_ok_to_mqtt_help',
                '⚠ Overrides the originating node\'s "ok_to_mqtt" preference. Only enable for private bridges where every gateway has consented.',
              )}
            </span>
          </span>
        </label>
      </CollapsibleSection>

      {/* --- Subscribe (downlink) --- */}
      <CollapsibleSection title={t('mqtt_bridge_config.section_subscribe', 'Subscribe (incoming)')}>
        <label className="dashboard-form-field">
          <span className="dashboard-form-label">
            {t('source.form.mqtt_subscriptions', 'Upstream topics (one per line)')}
          </span>
          <textarea
            className="dashboard-form-input"
            rows={3}
            value={form.subscriptions}
            disabled={!canWrite}
            onChange={(e) => patch('subscriptions', e.target.value)}
          />
        </label>
        <fieldset style={{ border: '1px solid var(--ctp-surface1)', borderRadius: 6, padding: '8px 12px 12px', margin: '8px 0' }}>
          <legend style={{ fontSize: 12, padding: '0 6px', color: 'var(--ctp-subtext0)' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.useTopicBlock}
                disabled={!canWrite}
                onChange={(e) => patch('useTopicBlock', e.target.checked)}
              />
              {t('source.form.mqtt_topic_block_enable', 'Block specific topics')}
            </label>
          </legend>
          {form.useTopicBlock && (
            <label className="dashboard-form-field" style={{ marginTop: 4 }}>
              <span className="dashboard-form-label">
                {t('source.form.mqtt_topic_block_label', 'Topics to drop (one per line, MQTT wildcards allowed)')}
              </span>
              <textarea
                className="dashboard-form-input"
                rows={3}
                value={form.topicBlock}
                disabled={!canWrite}
                onChange={(e) => patch('topicBlock', e.target.value)}
                placeholder="msh/CA/QC/#"
              />
            </label>
          )}
        </fieldset>
        <fieldset style={{ border: '1px solid var(--ctp-surface1)', borderRadius: 6, padding: '8px 12px 12px', margin: '8px 0' }}>
          <legend style={{ fontSize: 12, padding: '0 6px', color: 'var(--ctp-subtext0)' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.useGeo}
                disabled={!canWrite}
                onChange={(e) => patch('useGeo', e.target.checked)}
              />
              {t('source.form.mqtt_geo_enable', 'Restrict to geographic bounding box')}
            </label>
          </legend>
          {form.useGeo && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
              <BBoxMapEditor
                bbox={bboxFromForm(form.geo)}
                onChange={(next) =>
                  patch(
                    'geo',
                    next
                      ? bboxToFormStrings(next)
                      : { minLat: '', maxLat: '', minLng: '', maxLng: '' },
                  )
                }
              />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {GEO_KEYS.map((k) => (
                  <label className="dashboard-form-field" key={k}>
                    <span className="dashboard-form-label">{k}</span>
                    <input
                      className="dashboard-form-input"
                      value={form.geo[k]}
                      disabled={!canWrite}
                      onChange={(e) => patch('geo', { ...form.geo, [k]: e.target.value })}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
        </fieldset>
      </CollapsibleSection>

      {/* --- Publish (uplink) filters — #3294. Channel multiselect is primary;
              the raw topic filter is tucked into an Advanced subsection. --- */}
      <CollapsibleSection title={t('mqtt_bridge_config.section_publish', 'Publish (outgoing)')}>
        <span className="dashboard-form-label" style={{ display: 'block' }}>
          {t('source.form.mqtt_uplink_channels_label', 'Uplink only these channels')}
        </span>
        <span style={{ ...labelStyle, display: 'block', marginBottom: 8 }}>
          {t(
            'source.form.mqtt_uplink_channels_help',
            'Leave all unchecked to uplink every channel. Matched on the decoded channel name, regardless of MQTT topic format — the reliable way to uplink only specific channels (e.g. LongFast) while still receiving everything locally.',
          )}
        </span>
        {channelOptions.length > 0 ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              gap: 4,
              maxHeight: 200,
              overflowY: 'auto',
              border: '1px solid var(--ctp-surface1)',
              borderRadius: 6,
              padding: '8px 12px',
            }}
          >
            {channelOptions.map((name) => (
              <label
                key={name}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={selectedChannels.includes(name)}
                  disabled={!canWrite}
                  onChange={(e) => toggleChannel(name, e.target.checked)}
                />
                {name}
              </label>
            ))}
          </div>
        ) : (
          <span style={{ ...labelStyle, display: 'block' }}>
            {t(
              'source.form.mqtt_uplink_channels_empty',
              'No channels known yet — they appear here as the bridge sees traffic. Add one manually below, or use the Advanced topic filter.',
            )}
          </span>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            className="dashboard-form-input"
            style={{ flex: 1 }}
            type="text"
            value={customChannel}
            disabled={!canWrite}
            placeholder={t('source.form.mqtt_uplink_channels_add', 'Add channel name…')}
            onChange={(e) => setCustomChannel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addCustomChannel();
              }
            }}
          />
          <button
            type="button"
            className="btn-primary"
            onClick={addCustomChannel}
            disabled={!canWrite || !customChannel.trim()}
          >
            {t('common.add', 'Add')}
          </button>
        </div>

        <div style={{ marginTop: 12 }}>
          <CollapsibleSection
            title={t('mqtt_bridge_config.section_publish_advanced', 'Advanced: topic filter')}
            defaultExpanded={false}
          >
            <label className="dashboard-form-field">
              <span className="dashboard-form-label">
                {t('source.form.mqtt_uplink_topic_mode', 'Publish topic filter')}
              </span>
              <select
                className="dashboard-form-input"
                value={form.uplinkTopicMode ?? 'off'}
                disabled={!canWrite}
                onChange={(e) => patch('uplinkTopicMode', e.target.value as UplinkTopicMode)}
              >
                <option value="off">
                  {t('source.form.mqtt_uplink_topic_mode_off', 'Off — publish all subscribed topics')}
                </option>
                <option value="allow">
                  {t('source.form.mqtt_uplink_topic_mode_allow', 'Allow list — only publish matching topics')}
                </option>
                <option value="block">
                  {t('source.form.mqtt_uplink_topic_mode_block', 'Block list — publish all except matching topics')}
                </option>
              </select>
              <span style={labelStyle}>
                {t(
                  'source.form.mqtt_uplink_topic_help',
                  'Raw topic-pattern filter on the outgoing publish topic (MQTT wildcards). Composes with the channel selection above — both must pass. Only needed for filtering by something other than channel.',
                )}
              </span>
            </label>
            {form.uplinkTopicMode && form.uplinkTopicMode !== 'off' && (
              <label className="dashboard-form-field" style={{ marginTop: 4 }}>
                <span className="dashboard-form-label">
                  {t('source.form.mqtt_uplink_topics_label', 'Publish topics (one per line, MQTT wildcards allowed)')}
                </span>
                <textarea
                  className="dashboard-form-input"
                  rows={3}
                  value={form.uplinkTopics ?? ''}
                  disabled={!canWrite}
                  onChange={(e) => patch('uplinkTopics', e.target.value)}
                  placeholder="msh/US/FL/+/+/LongFast/#"
                />
              </label>
            )}
          </CollapsibleSection>
        </div>
      </CollapsibleSection>

      {/* --- Topic rewrites (only meaningful with a parent broker) --- */}
      {attached && (
        <CollapsibleSection
          title={t('mqtt_bridge_config.section_rewrites', 'Topic rewrites')}
          defaultExpanded={false}
        >
          <span style={{ ...labelStyle, display: 'block', marginBottom: 8 }}>
            {t(
              'mqtt_bridge_config.rewrites_help',
              'Literal prefix replacement applied to topics as they cross the bridge. Leave both fields blank to disable a rewrite. MQTT wildcards (+, #) are not allowed.',
            )}
          </span>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label className="dashboard-form-field">
              <span className="dashboard-form-label">
                {t('mqtt_bridge_config.downlink_rewrite_from', 'Downlink from')}
              </span>
              <input
                className="dashboard-form-input"
                value={form.downlinkRewrite?.from ?? ''}
                disabled={!canWrite}
                onChange={(e) =>
                  patch('downlinkRewrite', { from: e.target.value, to: form.downlinkRewrite?.to ?? '' })
                }
                placeholder="msh/US"
              />
            </label>
            <label className="dashboard-form-field">
              <span className="dashboard-form-label">
                {t('mqtt_bridge_config.downlink_rewrite_to', 'Downlink to')}
              </span>
              <input
                className="dashboard-form-input"
                value={form.downlinkRewrite?.to ?? ''}
                disabled={!canWrite}
                onChange={(e) =>
                  patch('downlinkRewrite', { from: form.downlinkRewrite?.from ?? '', to: e.target.value })
                }
                placeholder="msh/local"
              />
            </label>
            <label className="dashboard-form-field">
              <span className="dashboard-form-label">
                {t('mqtt_bridge_config.uplink_rewrite_from', 'Uplink from')}
              </span>
              <input
                className="dashboard-form-input"
                value={form.uplinkRewrite?.from ?? ''}
                disabled={!canWrite}
                onChange={(e) =>
                  patch('uplinkRewrite', { from: e.target.value, to: form.uplinkRewrite?.to ?? '' })
                }
                placeholder="msh/local"
              />
            </label>
            <label className="dashboard-form-field">
              <span className="dashboard-form-label">
                {t('mqtt_bridge_config.uplink_rewrite_to', 'Uplink to')}
              </span>
              <input
                className="dashboard-form-input"
                value={form.uplinkRewrite?.to ?? ''}
                disabled={!canWrite}
                onChange={(e) =>
                  patch('uplinkRewrite', { from: form.uplinkRewrite?.from ?? '', to: e.target.value })
                }
                placeholder="msh/US"
              />
            </label>
          </div>
        </CollapsibleSection>
      )}

      {/* --- Save --- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
        <button
          type="button"
          className="btn-primary"
          onClick={handleSave}
          disabled={!canWrite || saving}
        >
          {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
        </button>
        {saved && <span style={{ color: 'var(--ctp-green)' }}>✓ {t('common.saved', 'Saved')}</span>}
        {saveError && <span style={{ color: 'var(--ctp-red)' }}>{saveError}</span>}
      </div>
    </div>
  );
};

export default MqttBridgeConfigurationView;
