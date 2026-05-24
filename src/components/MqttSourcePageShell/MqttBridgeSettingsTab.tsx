/**
 * MqttBridgeSettingsTab — editable settings for an `mqtt_bridge` source.
 *
 * Fields mirror the legacy DashboardPage edit modal: name, parent broker
 * (or standalone), upstream URL/credentials, subscriptions, downlink
 * topic-block filter, downlink geo bbox filter. Topic-rewriting fields
 * are added by PR B (#3166) into the placeholder section near the
 * bottom.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { appBasename } from '../../init';
import { useCsrf } from '../../contexts/CsrfContext';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ToastContainer';
import './MqttSettingsTab.css';

export interface MqttBridgeSettingsTabProps {
  sourceId: string;
}

interface BridgeSourceResponse {
  id: string;
  name: string;
  type: string;
  config: {
    brokerSourceId?: string;
    upstream?: { url?: string; username?: string; password?: string };
    subscriptions?: string[];
    downlinkFilters?: {
      topics?: { block?: string[] };
      geo?: { minLat?: number; maxLat?: number; minLng?: number; maxLng?: number };
    };
    downlinkTopicRewrite?: { from?: string; to?: string };
    uplinkTopicRewrite?: { from?: string; to?: string };
  };
}

interface SourceListEntry {
  id: string;
  name: string;
  type: string;
}

export function MqttBridgeSettingsTab({ sourceId }: MqttBridgeSettingsTabProps) {
  const { t } = useTranslation();
  const { getToken } = useCsrf();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();

  const canEdit = hasPermission('configuration', 'write');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [availableBrokers, setAvailableBrokers] = useState<SourceListEntry[]>([]);

  const [name, setName] = useState('');
  const [brokerSourceId, setBrokerSourceId] = useState('');
  const [upstreamUrl, setUpstreamUrl] = useState('');
  const [upstreamUsername, setUpstreamUsername] = useState('');
  const [upstreamPassword, setUpstreamPassword] = useState('');
  const [subscriptions, setSubscriptions] = useState('msh/#');
  const [useTopicBlock, setUseTopicBlock] = useState(false);
  const [topicBlock, setTopicBlock] = useState('');
  const [useGeo, setUseGeo] = useState(false);
  const [geoMinLat, setGeoMinLat] = useState('');
  const [geoMaxLat, setGeoMaxLat] = useState('');
  const [geoMinLng, setGeoMinLng] = useState('');
  const [geoMaxLng, setGeoMaxLng] = useState('');

  // Topic rewriting (#3166) — literal prefix substitution applied at
  // publish time. Each direction is independent; empty fields disable
  // that direction.
  const [downlinkRewriteFrom, setDownlinkRewriteFrom] = useState('');
  const [downlinkRewriteTo, setDownlinkRewriteTo] = useState('');
  const [uplinkRewriteFrom, setUplinkRewriteFrom] = useState('');
  const [uplinkRewriteTo, setUplinkRewriteTo] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const [sourceRes, listRes] = await Promise.all([
          fetch(`${appBasename}/api/sources/${sourceId}`, { credentials: 'include' }),
          fetch(`${appBasename}/api/sources`, { credentials: 'include' }),
        ]);
        if (!sourceRes.ok) throw new Error(`HTTP ${sourceRes.status}`);
        const data = (await sourceRes.json()) as BridgeSourceResponse;
        const listData = listRes.ok ? ((await listRes.json()) as SourceListEntry[]) : [];
        if (cancelled) return;

        setName(data.name);
        setBrokerSourceId(data.config?.brokerSourceId ?? '');
        setUpstreamUrl(data.config?.upstream?.url ?? '');
        setUpstreamUsername(data.config?.upstream?.username ?? '');
        setUpstreamPassword('');
        setSubscriptions((data.config?.subscriptions ?? ['msh/#']).join('\n'));

        const block = data.config?.downlinkFilters?.topics?.block ?? [];
        setUseTopicBlock(block.length > 0);
        setTopicBlock(block.join('\n'));

        const geo = data.config?.downlinkFilters?.geo ?? {};
        const hasGeo =
          geo.minLat != null || geo.maxLat != null || geo.minLng != null || geo.maxLng != null;
        setUseGeo(hasGeo);
        setGeoMinLat(geo.minLat != null ? String(geo.minLat) : '');
        setGeoMaxLat(geo.maxLat != null ? String(geo.maxLat) : '');
        setGeoMinLng(geo.minLng != null ? String(geo.minLng) : '');
        setGeoMaxLng(geo.maxLng != null ? String(geo.maxLng) : '');

        const dlRewrite = data.config?.downlinkTopicRewrite ?? {};
        setDownlinkRewriteFrom(dlRewrite.from ?? '');
        setDownlinkRewriteTo(dlRewrite.to ?? '');
        const ulRewrite = data.config?.uplinkTopicRewrite ?? {};
        setUplinkRewriteFrom(ulRewrite.from ?? '');
        setUplinkRewriteTo(ulRewrite.to ?? '');

        setAvailableBrokers(listData.filter((s) => s.type === 'mqtt_broker'));
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  const onSave = async () => {
    if (!name.trim()) {
      setSaveError(t('source.form.error_name_required', 'Name is required'));
      return;
    }
    if (!upstreamUrl.trim()) {
      setSaveError(t('source.form.error_mqtt_url_required', 'Upstream URL is required'));
      return;
    }

    const subs = subscriptions
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const block = useTopicBlock
      ? topicBlock.split('\n').map((s) => s.trim()).filter(Boolean)
      : [];

    const geo: Record<string, number> = {};
    if (useGeo) {
      const fields: Array<[string, string]> = [
        ['minLat', geoMinLat],
        ['maxLat', geoMaxLat],
        ['minLng', geoMinLng],
        ['maxLng', geoMaxLng],
      ];
      for (const [key, val] of fields) {
        if (val.trim()) {
          const n = Number(val);
          if (Number.isNaN(n)) {
            setSaveError(t('source.form.error_geo_invalid', 'Geo bounds must be numbers'));
            return;
          }
          geo[key] = n;
        }
      }
    }

    const downlinkFilters: Record<string, unknown> = {};
    if (block.length > 0) downlinkFilters.topics = { block };
    if (Object.keys(geo).length > 0) downlinkFilters.geo = geo;

    // Topic rewriting (#3166) — server-side validator rejects rewrite
    // fields on standalone bridges, so omit them entirely when there's
    // no parent broker selected. Either direction is independent: omit
    // when both from and to are empty after trim.
    const dlFrom = downlinkRewriteFrom.trim();
    const dlTo = downlinkRewriteTo.trim();
    const ulFrom = uplinkRewriteFrom.trim();
    const ulTo = uplinkRewriteTo.trim();
    const wantDownlinkRewrite = brokerSourceId && (dlFrom || dlTo);
    const wantUplinkRewrite = brokerSourceId && (ulFrom || ulTo);
    if (wantDownlinkRewrite && (!dlFrom || !dlTo)) {
      setSaveError(
        t('source.form.error_rewrite_incomplete', 'Both from and to are required when a topic rewrite is set'),
      );
      return;
    }
    if (wantUplinkRewrite && (!ulFrom || !ulTo)) {
      setSaveError(
        t('source.form.error_rewrite_incomplete', 'Both from and to are required when a topic rewrite is set'),
      );
      return;
    }

    const cfg: Record<string, unknown> = {
      ...(brokerSourceId ? { brokerSourceId } : {}),
      upstream: {
        url: upstreamUrl.trim(),
        username: upstreamUsername.trim() || undefined,
        ...(upstreamPassword ? { password: upstreamPassword } : {}),
      },
      subscriptions: subs.length > 0 ? subs : ['msh/#'],
      ...(Object.keys(downlinkFilters).length > 0 ? { downlinkFilters } : {}),
      ...(wantDownlinkRewrite ? { downlinkTopicRewrite: { from: dlFrom, to: dlTo } } : {}),
      ...(wantUplinkRewrite ? { uplinkTopicRewrite: { from: ulFrom, to: ulTo } } : {}),
    };

    setSaving(true);
    setSaveError(null);
    try {
      const csrfToken = getToken();
      const res = await fetch(`${appBasename}/api/sources/${sourceId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken || '',
        },
        body: JSON.stringify({
          name: name.trim(),
          type: 'mqtt_bridge',
          config: cfg,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setSaveError((err as { error?: string }).error ?? t('source.form.error_save_failed', 'Failed to save'));
        return;
      }
      setUpstreamPassword('');
      showToast(t('source.form.saved', 'Settings saved'), 'success');
    } catch {
      setSaveError(t('source.form.error_network', 'Network error'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="mqtt-settings-tab">
        <p>{t('source.mqtt.settings.loading', 'Loading settings…')}</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mqtt-settings-tab">
        <p className="mqtt-settings-error">
          {t('source.mqtt.settings.load_error', 'Could not load source: {{err}}', { err: loadError })}
        </p>
      </div>
    );
  }

  const disabled = !canEdit || saving;
  const standalone = !brokerSourceId;

  return (
    <div className="mqtt-settings-tab">
      <h2>{t('source.mqtt_bridge.settings_title', 'Bridge Settings')}</h2>
      {!canEdit && (
        <p className="mqtt-settings-readonly">
          {t('source.mqtt.settings.readonly', 'Read-only — you do not have permission to edit this source.')}
        </p>
      )}

      <div className="mqtt-settings-field">
        <label htmlFor="bridge-name">{t('source.form.name', 'Name')}</label>
        <input
          id="bridge-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={disabled}
        />
      </div>

      <div className="mqtt-settings-field">
        <label htmlFor="bridge-parent">{t('source.form.parent_broker', 'Parent broker')}</label>
        <select
          id="bridge-parent"
          value={brokerSourceId}
          onChange={(e) => setBrokerSourceId(e.target.value)}
          disabled={disabled}
        >
          <option value="">
            {t('source.form.parent_broker_standalone', 'None — standalone client proxy')}
          </option>
          {availableBrokers.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <p className="mqtt-settings-hint">
          {standalone
            ? t(
                'source.form.parent_broker_hint_standalone',
                'Standalone — bridge runs as a pure upstream MQTT client. Use as a mqttLink client-proxy target for a Meshtastic source.',
              )
            : t(
                'source.form.parent_broker_hint_attached',
                'Attached — downlink traffic is republished to this broker so locally-connected devices see it; uplink traffic from the broker is forwarded upstream.',
              )}
        </p>
      </div>

      <h3>{t('source.form.upstream_section', 'Upstream connection')}</h3>

      <div className="mqtt-settings-field">
        <label htmlFor="bridge-url">{t('source.form.upstream_url', 'Upstream URL')}</label>
        <input
          id="bridge-url"
          type="url"
          value={upstreamUrl}
          onChange={(e) => setUpstreamUrl(e.target.value)}
          disabled={disabled}
          placeholder="mqtt://mqtt.meshtastic.org"
        />
        <p className="mqtt-settings-hint">
          {t(
            'source.form.upstream_url_hint',
            'mqtt:// for plain TCP, mqtts:// for TLS (e.g. mqtts://broker:8883).',
          )}
        </p>
      </div>

      <div className="mqtt-settings-field">
        <label htmlFor="bridge-username">{t('source.form.username', 'Username')}</label>
        <input
          id="bridge-username"
          type="text"
          value={upstreamUsername}
          onChange={(e) => setUpstreamUsername(e.target.value)}
          disabled={disabled}
          autoComplete="username"
        />
      </div>

      <div className="mqtt-settings-field">
        <label htmlFor="bridge-password">{t('source.form.password', 'Password')}</label>
        <input
          id="bridge-password"
          type="password"
          value={upstreamPassword}
          onChange={(e) => setUpstreamPassword(e.target.value)}
          disabled={disabled}
          placeholder={t('source.form.password_unchanged', '(unchanged)')}
          autoComplete="new-password"
        />
        <p className="mqtt-settings-hint">
          {t('source.form.password_hint', 'Leave blank to keep the current password.')}
        </p>
      </div>

      <h3>{t('source.form.subscriptions_section', 'Subscriptions')}</h3>

      <div className="mqtt-settings-field">
        <label htmlFor="bridge-subscriptions">{t('source.form.subscriptions', 'Upstream topics')}</label>
        <textarea
          id="bridge-subscriptions"
          value={subscriptions}
          onChange={(e) => setSubscriptions(e.target.value)}
          disabled={disabled}
          rows={5}
        />
        <p className="mqtt-settings-hint">
          {t(
            'source.form.subscriptions_hint',
            'One per line. MQTT wildcards allowed (+ single segment, # multi-segment tail). e.g. "msh/US/FL/#".',
          )}
        </p>
      </div>

      <h3>{t('source.form.downlink_filters_section', 'Downlink filters')}</h3>

      <div className="mqtt-settings-field mqtt-settings-checkbox">
        <label htmlFor="bridge-use-topic-block">
          <input
            id="bridge-use-topic-block"
            type="checkbox"
            checked={useTopicBlock}
            onChange={(e) => setUseTopicBlock(e.target.checked)}
            disabled={disabled}
          />
          <span>{t('source.form.topic_block', 'Block topics matching these patterns')}</span>
        </label>
      </div>

      {useTopicBlock && (
        <div className="mqtt-settings-field">
          <label htmlFor="bridge-topic-block">{t('source.form.topic_block_label', 'Block patterns')}</label>
          <textarea
            id="bridge-topic-block"
            value={topicBlock}
            onChange={(e) => setTopicBlock(e.target.value)}
            disabled={disabled}
            rows={4}
            placeholder="msh/CA/QC/#"
          />
          <p className="mqtt-settings-hint">
            {t('source.form.topic_block_hint', 'One per line. MQTT wildcards allowed.')}
          </p>
        </div>
      )}

      <div className="mqtt-settings-field mqtt-settings-checkbox">
        <label htmlFor="bridge-use-geo">
          <input
            id="bridge-use-geo"
            type="checkbox"
            checked={useGeo}
            onChange={(e) => setUseGeo(e.target.checked)}
            disabled={disabled}
          />
          <span>{t('source.form.geo_bbox', 'Drop position packets outside a bounding box')}</span>
        </label>
      </div>

      {useGeo && (
        <div className="mqtt-settings-field">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label htmlFor="bridge-geo-minlat">{t('source.form.geo_min_lat', 'Min latitude')}</label>
              <input
                id="bridge-geo-minlat"
                type="number"
                step="0.001"
                value={geoMinLat}
                onChange={(e) => setGeoMinLat(e.target.value)}
                disabled={disabled}
              />
            </div>
            <div>
              <label htmlFor="bridge-geo-maxlat">{t('source.form.geo_max_lat', 'Max latitude')}</label>
              <input
                id="bridge-geo-maxlat"
                type="number"
                step="0.001"
                value={geoMaxLat}
                onChange={(e) => setGeoMaxLat(e.target.value)}
                disabled={disabled}
              />
            </div>
            <div>
              <label htmlFor="bridge-geo-minlng">{t('source.form.geo_min_lng', 'Min longitude')}</label>
              <input
                id="bridge-geo-minlng"
                type="number"
                step="0.001"
                value={geoMinLng}
                onChange={(e) => setGeoMinLng(e.target.value)}
                disabled={disabled}
              />
            </div>
            <div>
              <label htmlFor="bridge-geo-maxlng">{t('source.form.geo_max_lng', 'Max longitude')}</label>
              <input
                id="bridge-geo-maxlng"
                type="number"
                step="0.001"
                value={geoMaxLng}
                onChange={(e) => setGeoMaxLng(e.target.value)}
                disabled={disabled}
              />
            </div>
          </div>
        </div>
      )}

      <h3>{t('source.form.topic_rewrite_section', 'Topic rewriting')}</h3>
      <p className="mqtt-settings-hint">
        {t(
          'source.form.topic_rewrite_intro',
          'Literal prefix replacement applied at publish time. Use this to bridge between meshes that publish under different MQTT root topics. Leave blank to disable.',
        )}
      </p>
      {standalone ? (
        <p className="mqtt-settings-readonly">
          {t(
            'source.form.topic_rewrite_standalone_warning',
            'Topic rewriting requires a parent broker — attach one above to enable these fields.',
          )}
        </p>
      ) : (
        <>
          <div className="mqtt-settings-field">
            <label>
              {t('source.form.topic_rewrite_downlink', 'Downlink (upstream → local broker)')}
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div>
                <label htmlFor="bridge-rewrite-dl-from">
                  {t('source.form.topic_rewrite_from', 'From prefix')}
                </label>
                <input
                  id="bridge-rewrite-dl-from"
                  type="text"
                  value={downlinkRewriteFrom}
                  onChange={(e) => setDownlinkRewriteFrom(e.target.value)}
                  disabled={disabled}
                  placeholder="msh/US/TX"
                />
              </div>
              <div>
                <label htmlFor="bridge-rewrite-dl-to">
                  {t('source.form.topic_rewrite_to', 'To prefix')}
                </label>
                <input
                  id="bridge-rewrite-dl-to"
                  type="text"
                  value={downlinkRewriteTo}
                  onChange={(e) => setDownlinkRewriteTo(e.target.value)}
                  disabled={disabled}
                  placeholder="msh/US/LA"
                />
              </div>
            </div>
            <p className="mqtt-settings-hint">
              {t(
                'source.form.topic_rewrite_downlink_hint',
                'Inbound packets whose topic starts with the From prefix are republished to the parent broker under the To prefix. Ingestion and filters still use the original topic.',
              )}
            </p>
          </div>

          <div className="mqtt-settings-field">
            <label>
              {t('source.form.topic_rewrite_uplink', 'Uplink (local broker → upstream)')}
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div>
                <label htmlFor="bridge-rewrite-ul-from">
                  {t('source.form.topic_rewrite_from', 'From prefix')}
                </label>
                <input
                  id="bridge-rewrite-ul-from"
                  type="text"
                  value={uplinkRewriteFrom}
                  onChange={(e) => setUplinkRewriteFrom(e.target.value)}
                  disabled={disabled}
                  placeholder="msh/US/LA"
                />
              </div>
              <div>
                <label htmlFor="bridge-rewrite-ul-to">
                  {t('source.form.topic_rewrite_to', 'To prefix')}
                </label>
                <input
                  id="bridge-rewrite-ul-to"
                  type="text"
                  value={uplinkRewriteTo}
                  onChange={(e) => setUplinkRewriteTo(e.target.value)}
                  disabled={disabled}
                  placeholder="msh/US/TX"
                />
              </div>
            </div>
            <p className="mqtt-settings-hint">
              {t(
                'source.form.topic_rewrite_uplink_hint',
                'Outbound packets from the parent broker whose topic starts with the From prefix are published upstream under the To prefix.',
              )}
            </p>
          </div>

          <p className="mqtt-settings-hint">
            {t(
              'source.form.topic_rewrite_caveats',
              'Caveats: rewriting moves bytes, not encryption — the channel PSK must match between meshes for inter-mesh packets to decode. Pair with the broker\'s "Zero-hop injection" setting to keep cross-bridged packets from triggering extra RF hops. Literal prefix only (no MQTT + / # wildcards).',
            )}
          </p>
        </>
      )}

      {saveError && <p className="mqtt-settings-error">{saveError}</p>}

      {canEdit && (
        <div className="mqtt-settings-actions">
          <button type="button" onClick={onSave} disabled={saving}>
            {saving ? t('source.form.saving', 'Saving…') : t('source.form.save', 'Save')}
          </button>
        </div>
      )}
    </div>
  );
}
