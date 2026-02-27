import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { MapContainer, TileLayer, useMapEvents, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import apiService from '../../services/api';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { getAllTilesets } from '../../config/tilesets';
import { useSettings } from '../../contexts/SettingsContext';

// Fix default marker icon for Leaflet in bundled builds
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

/** Shape matching the backend EmbedProfile */
interface EmbedProfile {
  id: string;
  name: string;
  enabled: boolean;
  channels: number[];
  tileset: string;
  defaultLat: number;
  defaultLng: number;
  defaultZoom: number;
  showTooltips: boolean;
  showPopups: boolean;
  showLegend: boolean;
  showPaths: boolean;
  showNeighborInfo: boolean;
  showMqttNodes: boolean;
  pollIntervalSeconds: number;
  allowedOrigins: string[];
  createdAt: number;
  updatedAt: number;
}

type ProfileFormData = Omit<EmbedProfile, 'id' | 'createdAt' | 'updatedAt'>;

const DEFAULT_FORM: ProfileFormData = {
  name: '',
  enabled: true,
  channels: [0],
  tileset: 'osm',
  defaultLat: 0,
  defaultLng: 0,
  defaultZoom: 10,
  showTooltips: true,
  showPopups: true,
  showLegend: true,
  showPaths: false,
  showNeighborInfo: false,
  showMqttNodes: true,
  pollIntervalSeconds: 30,
  allowedOrigins: [],
};

// ---------------------------------------------------------------------------
// Mini-map sub-components for picking center/zoom
// ---------------------------------------------------------------------------

interface MapClickHandlerProps {
  onLocationPick: (lat: number, lng: number) => void;
  onZoomChange: (zoom: number) => void;
}

function MapClickHandler({ onLocationPick, onZoomChange }: MapClickHandlerProps) {
  useMapEvents({
    click(e) {
      onLocationPick(
        Math.round(e.latlng.lat * 1e6) / 1e6,
        Math.round(e.latlng.lng * 1e6) / 1e6,
      );
    },
    zoomend(e) {
      onZoomChange(e.target.getZoom());
    },
  });
  return null;
}

interface MapCenterUpdaterProps {
  lat: number;
  lng: number;
}

function MapCenterUpdater({ lat, lng }: MapCenterUpdaterProps) {
  const map = useMap();
  useEffect(() => {
    map.setView([lat, lng], map.getZoom(), { animate: true });
  }, [lat, lng, map]);
  return null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const EmbedSettings: React.FC = () => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { customTilesets } = useSettings();

  const [profiles, setProfiles] = useState<EmbedProfile[]>([]);
  const [loading, setLoading] = useState(true);

  // Editing state: null = list view, 'new' = creating, string = editing that id
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProfileFormData>({ ...DEFAULT_FORM });

  // Embed-code copy modal
  const [copyProfileId, setCopyProfileId] = useState<string | null>(null);

  const tilesets = getAllTilesets(customTilesets);

  // ---- Data fetching ----
  const fetchProfiles = useCallback(async () => {
    try {
      const data = await apiService.get<EmbedProfile[]>('/api/embed-profiles');
      setProfiles(data);
    } catch (err: any) {
      showToast(err.message || t('settings.embed.fetch_error', 'Failed to load embed profiles'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast, t]);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  // ---- Form helpers ----
  const openCreate = () => {
    setForm({ ...DEFAULT_FORM });
    setEditingId('new');
  };

  const openEdit = (profile: EmbedProfile) => {
    setForm({
      name: profile.name,
      enabled: profile.enabled,
      channels: [...profile.channels],
      tileset: profile.tileset,
      defaultLat: profile.defaultLat,
      defaultLng: profile.defaultLng,
      defaultZoom: profile.defaultZoom,
      showTooltips: profile.showTooltips,
      showPopups: profile.showPopups,
      showLegend: profile.showLegend,
      showPaths: profile.showPaths,
      showNeighborInfo: profile.showNeighborInfo,
      showMqttNodes: profile.showMqttNodes,
      pollIntervalSeconds: profile.pollIntervalSeconds,
      allowedOrigins: [...profile.allowedOrigins],
    });
    setEditingId(profile.id);
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const toggleChannel = (ch: number) => {
    setForm(prev => {
      const next = prev.channels.includes(ch)
        ? prev.channels.filter(c => c !== ch)
        : [...prev.channels, ch].sort((a, b) => a - b);
      return { ...prev, channels: next };
    });
  };

  // ---- CRUD ----
  const handleSave = async () => {
    if (!form.name.trim()) {
      showToast(t('settings.embed.name_required', 'Profile name is required'), 'error');
      return;
    }

    try {
      if (editingId === 'new') {
        await apiService.post<EmbedProfile>('/api/embed-profiles', form);
        showToast(t('settings.embed.created', 'Embed profile created'), 'success');
      } else {
        await apiService.put<EmbedProfile>(`/api/embed-profiles/${editingId}`, form);
        showToast(t('settings.embed.updated', 'Embed profile updated'), 'success');
      }
      setEditingId(null);
      await fetchProfiles();
    } catch (err: any) {
      showToast(err.message || t('settings.embed.save_error', 'Failed to save embed profile'), 'error');
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t('settings.embed.delete_confirm', 'Are you sure you want to delete this embed profile?'))) {
      return;
    }
    try {
      // Use csrfFetch for DELETE since the endpoint returns 204 (no JSON body)
      const res = await csrfFetch(`/meshmonitor/api/embed-profiles/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Delete failed' }));
        throw new Error(err.error);
      }
      showToast(t('settings.embed.deleted', 'Embed profile deleted'), 'success');
      await fetchProfiles();
    } catch (err: any) {
      showToast(err.message || t('settings.embed.delete_error', 'Failed to delete embed profile'), 'error');
    }
  };

  // ---- Embed code builder ----
  const buildEmbedUrl = (profileId: string): string => {
    const origin = window.location.origin;
    // Strip trailing slash from pathname base
    const base = window.location.pathname.replace(/\/+$/, '').replace(/\/[^/]*$/, '');
    return `${origin}${base}/embed/${profileId}`;
  };

  const buildIframeSnippet = (profileId: string): string => {
    const url = buildEmbedUrl(profileId);
    return `<iframe src="${url}" width="800" height="600" frameborder="0" style="border:0" allowfullscreen></iframe>`;
  };

  const handleCopyEmbed = (profileId: string) => {
    setCopyProfileId(profileId);
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('settings.embed.copied', 'Copied to clipboard'), 'success');
    } catch {
      showToast(t('settings.embed.copy_failed', 'Failed to copy'), 'error');
    }
  };

  // ---- Render helpers ----

  if (loading) {
    return <p>{t('settings.embed.loading', 'Loading embed profiles...')}</p>;
  }

  // ===== FORM VIEW =====
  if (editingId !== null) {
    return (
      <div className="embed-settings-form">
        <h4>{editingId === 'new' ? t('settings.embed.create_title', 'Create Embed Profile') : t('settings.embed.edit_title', 'Edit Embed Profile')}</h4>

        {/* Name */}
        <div className="setting-item">
          <label htmlFor="embed-name">{t('settings.embed.name', 'Name')}</label>
          <input
            id="embed-name"
            type="text"
            value={form.name}
            onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
            placeholder={t('settings.embed.name_placeholder', 'My Embed Map')}
          />
        </div>

        {/* Enabled */}
        <div className="setting-item">
          <label>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={e => setForm(prev => ({ ...prev, enabled: e.target.checked }))}
            />
            {' '}{t('settings.embed.enabled', 'Enabled')}
          </label>
        </div>

        {/* Channels */}
        <div className="setting-item">
          <label>{t('settings.embed.channels', 'Channels')}</label>
          <div className="embed-channels-grid">
            {Array.from({ length: 8 }, (_, i) => (
              <label key={i} className="embed-channel-checkbox">
                <input
                  type="checkbox"
                  checked={form.channels.includes(i)}
                  onChange={() => toggleChannel(i)}
                />
                {' '}{t('settings.embed.channel_n', 'Channel {{n}}', { n: i })}
              </label>
            ))}
          </div>
        </div>

        {/* Tileset */}
        <div className="setting-item">
          <label htmlFor="embed-tileset">{t('settings.embed.tileset', 'Map Tileset')}</label>
          <select
            id="embed-tileset"
            value={form.tileset}
            onChange={e => setForm(prev => ({ ...prev, tileset: e.target.value }))}
          >
            {tilesets.filter(ts => !ts.isVector).map(ts => (
              <option key={ts.id} value={ts.id}>{ts.name}</option>
            ))}
          </select>
        </div>

        {/* Map picker for center + zoom */}
        <div className="setting-item">
          <label>{t('settings.embed.map_center', 'Default Map Center & Zoom')}</label>
          <p className="setting-description">
            {t('settings.embed.map_center_help', 'Click the map to set the center. Zoom with scroll or controls.')}
          </p>
          <div className="embed-map-picker" style={{ height: 300, width: '100%', marginBottom: 8 }}>
            <MapContainer
              center={[form.defaultLat, form.defaultLng]}
              zoom={form.defaultZoom}
              style={{ height: '100%', width: '100%' }}
              scrollWheelZoom
            >
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution="&copy; OpenStreetMap contributors"
              />
              <MapClickHandler
                onLocationPick={(lat, lng) => setForm(prev => ({ ...prev, defaultLat: lat, defaultLng: lng }))}
                onZoomChange={(zoom) => setForm(prev => ({ ...prev, defaultZoom: zoom }))}
              />
              <MapCenterUpdater lat={form.defaultLat} lng={form.defaultLng} />
              <Marker position={[form.defaultLat, form.defaultLng]} />
            </MapContainer>
          </div>
          <div className="embed-map-coords">
            <span>{t('settings.embed.lat', 'Lat')}: <strong>{form.defaultLat}</strong></span>
            {' | '}
            <span>{t('settings.embed.lng', 'Lng')}: <strong>{form.defaultLng}</strong></span>
            {' | '}
            <span>{t('settings.embed.zoom', 'Zoom')}: <strong>{form.defaultZoom}</strong></span>
          </div>
        </div>

        {/* Feature toggles */}
        <div className="setting-item">
          <label>{t('settings.embed.features', 'Feature Toggles')}</label>
          <div className="embed-features-grid">
            {([
              ['showTooltips', t('settings.embed.show_tooltips', 'Show Tooltips')],
              ['showPopups', t('settings.embed.show_popups', 'Show Popups')],
              ['showLegend', t('settings.embed.show_legend', 'Show Legend')],
              ['showPaths', t('settings.embed.show_paths', 'Show Paths')],
              ['showNeighborInfo', t('settings.embed.show_neighbor_info', 'Show Neighbor Info')],
              ['showMqttNodes', t('settings.embed.show_mqtt_nodes', 'Show MQTT Nodes')],
            ] as [keyof ProfileFormData, string][]).map(([key, label]) => (
              <label key={key} className="embed-feature-checkbox">
                <input
                  type="checkbox"
                  checked={form[key] as boolean}
                  onChange={e => setForm(prev => ({ ...prev, [key]: e.target.checked }))}
                />
                {' '}{label}
              </label>
            ))}
          </div>
        </div>

        {/* Poll interval */}
        <div className="setting-item">
          <label htmlFor="embed-poll">{t('settings.embed.poll_interval', 'Poll Interval (seconds)')}</label>
          <input
            id="embed-poll"
            type="number"
            min={10}
            max={300}
            value={form.pollIntervalSeconds}
            onChange={e => {
              const val = Math.max(10, Math.min(300, Number(e.target.value) || 30));
              setForm(prev => ({ ...prev, pollIntervalSeconds: val }));
            }}
          />
        </div>

        {/* Allowed origins */}
        <div className="setting-item">
          <label htmlFor="embed-origins">{t('settings.embed.allowed_origins', 'Allowed Origins')}</label>
          <p className="setting-description">
            {t('settings.embed.allowed_origins_help', 'Comma-separated URLs that may embed this map. Leave blank to allow any origin.')}
          </p>
          <input
            id="embed-origins"
            type="text"
            value={form.allowedOrigins.join(', ')}
            onChange={e => {
              const origins = e.target.value
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);
              setForm(prev => ({ ...prev, allowedOrigins: origins }));
            }}
            placeholder="https://example.com, https://other-site.org"
          />
        </div>

        {/* Security note */}
        <div className="embed-info-box">
          <strong>{t('settings.embed.security_note_title', 'Security Note')}</strong>
          <p>
            {t(
              'settings.embed.security_note',
              'Embed maps are served using the anonymous user permissions. Make sure the anonymous user has read access to the channels you want to display. If anonymous access is disabled, embed maps will not work.'
            )}
          </p>
        </div>

        {/* Actions */}
        <div className="settings-buttons" style={{ marginTop: 16 }}>
          <button className="btn btn-primary" onClick={handleSave}>
            {editingId === 'new' ? t('settings.embed.create_btn', 'Create') : t('settings.embed.save_btn', 'Save')}
          </button>
          <button className="btn" onClick={cancelEdit} style={{ marginLeft: 8 }}>
            {t('settings.embed.cancel_btn', 'Cancel')}
          </button>
        </div>
      </div>
    );
  }

  // ===== LIST VIEW =====
  return (
    <div className="embed-settings">
      <p className="setting-description">
        {t('settings.embed.description', 'Create embed profiles to share interactive maps on external websites via iframe.')}
      </p>

      <button className="btn btn-primary" onClick={openCreate} style={{ marginBottom: 12 }}>
        {t('settings.embed.add_profile', '+ New Embed Profile')}
      </button>

      {profiles.length === 0 ? (
        <p className="setting-description">{t('settings.embed.none', 'No embed profiles yet.')}</p>
      ) : (
        <table className="embed-profiles-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '8px 4px' }}>{t('settings.embed.col_name', 'Name')}</th>
              <th style={{ textAlign: 'center', padding: '8px 4px' }}>{t('settings.embed.col_enabled', 'Enabled')}</th>
              <th style={{ textAlign: 'right', padding: '8px 4px' }}>{t('settings.embed.col_actions', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map(p => (
              <tr key={p.id} style={{ borderTop: '1px solid var(--border-color, #ddd)' }}>
                <td style={{ padding: '8px 4px' }}>{p.name}</td>
                <td style={{ textAlign: 'center', padding: '8px 4px' }}>
                  {p.enabled
                    ? <span style={{ color: 'var(--success-color, green)' }}>{t('settings.embed.yes', 'Yes')}</span>
                    : <span style={{ color: 'var(--error-color, red)' }}>{t('settings.embed.no', 'No')}</span>}
                </td>
                <td style={{ textAlign: 'right', padding: '8px 4px', whiteSpace: 'nowrap' }}>
                  <button className="btn" onClick={() => openEdit(p)} style={{ marginRight: 4 }}>
                    {t('settings.embed.edit_btn', 'Edit')}
                  </button>
                  <button className="btn" onClick={() => handleCopyEmbed(p.id)} style={{ marginRight: 4 }}>
                    {t('settings.embed.copy_embed', 'Embed Code')}
                  </button>
                  <button className="btn btn-danger" onClick={() => handleDelete(p.id)}>
                    {t('settings.embed.delete_btn', 'Delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Embed code preview modal */}
      {copyProfileId && (
        <div className="embed-code-preview" style={{ marginTop: 16 }}>
          <h4>{t('settings.embed.embed_code_title', 'Embed Code')}</h4>
          <p className="setting-description">
            {t('settings.embed.embed_code_help', 'Copy this HTML snippet and paste it into your website.')}
          </p>
          <textarea
            readOnly
            rows={3}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.85em' }}
            value={buildIframeSnippet(copyProfileId)}
            onClick={e => (e.target as HTMLTextAreaElement).select()}
          />
          <div style={{ marginTop: 8 }}>
            <button className="btn btn-primary" onClick={() => copyToClipboard(buildIframeSnippet(copyProfileId))}>
              {t('settings.embed.copy_btn', 'Copy to Clipboard')}
            </button>
            <button className="btn" onClick={() => setCopyProfileId(null)} style={{ marginLeft: 8 }}>
              {t('settings.embed.close_btn', 'Close')}
            </button>
          </div>
        </div>
      )}

      {/* Security info box */}
      <div className="embed-info-box" style={{ marginTop: 16 }}>
        <strong>{t('settings.embed.security_note_title', 'Security Note')}</strong>
        <p>
          {t(
            'settings.embed.security_note',
            'Embed maps are served using the anonymous user permissions. Make sure the anonymous user has read access to the channels you want to display. If anonymous access is disabled, embed maps will not work.'
          )}
        </p>
      </div>
    </div>
  );
};

export default EmbedSettings;
