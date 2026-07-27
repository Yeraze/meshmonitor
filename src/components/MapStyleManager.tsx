import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import type { MapStyle } from '../server/services/mapStyleService.js';
import api from '../services/api';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSettings } from '../contexts/SettingsContext';
import { UiIcon } from './icons';

const MapStyleManager: React.FC = () => {
  const { t } = useTranslation();
  const [styles, setStyles] = useState<MapStyle[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [fetchingUrl, setFetchingUrl] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [importName, setImportName] = useState('');
  const [tileJsonUrl, setTileJsonUrl] = useState('');
  const [tileJsonName, setTileJsonName] = useState('');
  const [generatingStyle, setGeneratingStyle] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csrfFetch = useCsrfFetch();
  const { activeStyleId, setActiveMapStyleId, loadMapStyles } = useSettings();

  const fetchStyles = useCallback(async () => {
    try {
      const data = await api.get<MapStyle[]>('/api/map-styles/styles');
      setStyles(data);
    } catch (err) {
      console.error('Failed to fetch map styles:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStyles();
  }, [fetchStyles]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const baseUrl = await api.getBaseUrl();
      const buffer = await file.arrayBuffer();
      const response = await csrfFetch(`${baseUrl}/api/map-styles/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': file.name,
        },
        body: buffer,
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error ?? t('map_style_manager.unknown_error'));
      }
      await fetchStyles();
      await loadMapStyles();
    } catch (err) {
      console.error('Failed to upload map style:', err);
      alert(t('map_style_manager.upload_failed', {
        message: err instanceof Error ? err.message : t('map_style_manager.unknown_error'),
      }));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleFetchUrl = async () => {
    if (!importUrl.trim()) return;
    setFetchingUrl(true);
    try {
      const baseUrl = await api.getBaseUrl();
      const response = await csrfFetch(`${baseUrl}/api/map-styles/from-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: importUrl.trim(), name: importName.trim() || undefined }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error ?? t('map_style_manager.unknown_error'));
      }
      setImportUrl('');
      setImportName('');
      await fetchStyles();
      await loadMapStyles();
    } catch (err) {
      console.error('Failed to import map style from URL:', err);
      alert(t('map_style_manager.import_failed', {
        message: err instanceof Error ? err.message : t('map_style_manager.unknown_error'),
      }));
    } finally {
      setFetchingUrl(false);
    }
  };

  const handleGenerateFromTileserver = async () => {
    if (!tileJsonUrl.trim()) return;
    setGeneratingStyle(true);
    try {
      const baseUrl = await api.getBaseUrl();
      const response = await csrfFetch(`${baseUrl}/api/map-styles/generate-from-tileserver`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tileJsonUrl: tileJsonUrl.trim(), name: tileJsonName.trim() || undefined }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error ?? t('map_style_manager.unknown_error'));
      }
      const { style, filename } = await response.json() as { style: object; filename: string };
      // Trigger browser download
      const blob = new Blob([JSON.stringify(style, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setTileJsonUrl('');
      setTileJsonName('');
    } catch (err) {
      console.error('Failed to generate map style from tileserver:', err);
      // The static hint is a separate key so translators get a clean sentence
      // instead of one string mixing {{message}} with literal \n\n formatting.
      const failure = t('map_style_manager.generate_failed', {
        message: err instanceof Error ? err.message : t('map_style_manager.unknown_error'),
      });
      alert(`${failure}\n\n${t('map_style_manager.generate_failed_hint')}`);
    } finally {
      setGeneratingStyle(false);
    }
  };

  const updateStyle = async (id: string, updates: { name: string }) => {
    try {
      const baseUrl = await api.getBaseUrl();
      const response = await csrfFetch(`${baseUrl}/api/map-styles/styles/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!response.ok) throw new Error('Update failed');
      const updated = await response.json();
      setStyles(prev => prev.map(s => s.id === id ? updated : s));
    } catch (err) {
      console.error('Failed to update map style:', err);
    }
  };

  const deleteStyle = async (id: string, name: string) => {
    if (!confirm(t('map_style_manager.delete_confirm', { name }))) return;
    try {
      const baseUrl = await api.getBaseUrl();
      const response = await csrfFetch(`${baseUrl}/api/map-styles/styles/${id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error(t('map_style_manager.unknown_error'));
      setStyles(prev => prev.filter(s => s.id !== id));
      if (activeStyleId === id) {
        // The active style just got deleted — clear the selection everywhere.
        await setActiveMapStyleId(null);
      }
      await loadMapStyles();
    } catch (err) {
      console.error('Failed to delete map style:', err);
      alert(t('map_style_manager.delete_failed', {
        message: err instanceof Error ? err.message : t('map_style_manager.unknown_error'),
      }));
    }
  };

  if (loading) {
    return <div className="setting-item"><span>{t('map_style_manager.loading')}</span></div>;
  }

  return (
    <div>
      <div className="setting-item">
        <label>
          {t('map_style_manager.title')}
          <span className="setting-description">{t('map_style_manager.description')}</span>
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {/* Import: upload a file directly, or fetch a ready style.json by URL.
              Both save immediately as a usable map style (issue #4348). */}
          <div style={{ fontWeight: 600, fontSize: '0.9em' }}>{t('map_style_manager.import_title')}</div>
          <div style={{ fontSize: '0.85em', color: 'var(--text-muted, #888)', marginBottom: '2px' }}>
            {t('map_style_manager.import_desc')}
          </div>

          {/* File upload */}
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleUpload(file);
              }}
            />
            <button
              className="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? t('map_style_manager.uploading') : t('map_style_manager.upload_button')}
            </button>
          </div>

          {/* URL import */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder={t('map_style_manager.style_url_placeholder')}
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              style={{ flex: 2, minWidth: '160px', padding: '4px 8px', border: '1px solid var(--border-color, #ccc)', borderRadius: '3px', background: 'var(--input-bg, #fff)', color: 'var(--text-color, #000)' }}
            />
            <input
              type="text"
              placeholder={t('map_style_manager.name_placeholder')}
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
              style={{ flex: 1, minWidth: '100px', padding: '4px 8px', border: '1px solid var(--border-color, #ccc)', borderRadius: '3px', background: 'var(--input-bg, #fff)', color: 'var(--text-color, #000)' }}
            />
            <button
              className="button"
              onClick={handleFetchUrl}
              disabled={fetchingUrl || !importUrl.trim()}
            >
              {fetchingUrl ? t('map_style_manager.fetching') : t('map_style_manager.fetch_button')}
            </button>
          </div>

          {/* Generate from tileserver: this is a DIFFERENT feature from the
              import above — it builds a brand-new style from a raw TileJSON
              endpoint and only downloads it to your browser (issue #4348,
              problem 3). It does not save a map style server-side; edit the
              downloaded file and upload it above to actually use it. */}
          <div style={{ marginTop: '8px', borderTop: '1px solid var(--border-color, #eee)', paddingTop: '8px' }}>
            <div style={{ fontWeight: 600, fontSize: '0.9em' }}>{t('map_style_manager.generate_title')}</div>
            <div style={{ fontSize: '0.85em', color: 'var(--text-muted, #888)', margin: '2px 0 4px' }}>
              {/* Kept as one translatable sentence (rather than split around the
                  <code> element) so translators can reorder it freely. */}
              <Trans
                i18nKey="map_style_manager.generate_desc"
                components={{ code: <code style={{ fontSize: '0.9em' }} /> }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder={t('map_style_manager.tilejson_url_placeholder')}
                value={tileJsonUrl}
                onChange={(e) => setTileJsonUrl(e.target.value)}
                style={{ flex: 2, minWidth: '200px', padding: '4px 8px', border: '1px solid var(--border-color, #ccc)', borderRadius: '3px', background: 'var(--input-bg, #fff)', color: 'var(--text-color, #000)' }}
              />
              <input
                type="text"
                placeholder={t('map_style_manager.name_placeholder')}
                value={tileJsonName}
                onChange={(e) => setTileJsonName(e.target.value)}
                style={{ flex: 1, minWidth: '100px', padding: '4px 8px', border: '1px solid var(--border-color, #ccc)', borderRadius: '3px', background: 'var(--input-bg, #fff)', color: 'var(--text-color, #000)' }}
              />
              <button
                className="button"
                onClick={handleGenerateFromTileserver}
                disabled={generatingStyle || !tileJsonUrl.trim()}
              >
                {generatingStyle ? t('map_style_manager.generating') : t('map_style_manager.generate_button')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {styles.length === 0 ? (
        <div className="setting-item">
          <span style={{ color: 'var(--text-muted, #888)', fontStyle: 'italic' }}>
            {t('map_style_manager.no_styles')}
          </span>
        </div>
      ) : (
        styles.map(style => (
          <div key={style.id} className="setting-item">
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%' }}>
              {/* Editable name */}
              <input
                type="text"
                value={style.name}
                onChange={(e) => setStyles(prev => prev.map(s => s.id === style.id ? { ...s, name: e.target.value } : s))}
                onBlur={(e) => updateStyle(style.id, { name: e.target.value })}
                style={{ flex: 1, padding: '2px 6px', border: '1px solid var(--border-color, #ccc)', borderRadius: '3px', background: 'var(--input-bg, #fff)', color: 'var(--text-color, #000)' }}
              />

              {/* Source badge */}
              <span style={{
                fontSize: '0.75em',
                padding: '2px 6px',
                borderRadius: '3px',
                background: style.sourceType === 'upload' ? 'var(--accent-color, #4a9eff)' : 'var(--success-color, #28a745)',
                color: '#fff',
                whiteSpace: 'nowrap',
              }}>
                {style.sourceType === 'upload'
                  ? t('map_style_manager.source_upload')
                  : t('map_style_manager.source_url')}
              </span>

              {/* Active indicator / Activate action — same "which style is
                  used on the map" state as the in-map "Map Style" dropdown,
                  surfaced here so it's discoverable from Settings (#4348). */}
              {activeStyleId === style.id ? (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: '0.75em',
                  padding: '2px 6px',
                  borderRadius: '3px',
                  background: 'var(--success-color, #28a745)',
                  color: '#fff',
                  whiteSpace: 'nowrap',
                }}>
                  <UiIcon name="check" /> {t('map_style_manager.active')}
                </span>
              ) : (
                <button
                  onClick={() => void setActiveMapStyleId(style.id)}
                  style={{ padding: '2px 8px', background: 'var(--accent-color, #4a9eff)', color: '#fff', border: 'none', borderRadius: '3px', cursor: 'pointer', fontSize: '0.85em', whiteSpace: 'nowrap' }}
                >
                  {t('map_style_manager.activate')}
                </button>
              )}

              {/* Delete */}
              <button
                onClick={() => deleteStyle(style.id, style.name)}
                style={{ padding: '2px 8px', background: 'var(--danger-color, #dc3545)', color: '#fff', border: 'none', borderRadius: '3px', cursor: 'pointer', fontSize: '0.85em' }}
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
};

export default MapStyleManager;
