import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { MapStyle } from '../server/services/mapStyleService.js';
import api from '../services/api';
import { useCsrfFetch } from '../hooks/useCsrfFetch';

const MapStyleManager: React.FC = () => {
  const [styles, setStyles] = useState<MapStyle[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [fetchingUrl, setFetchingUrl] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [importName, setImportName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csrfFetch = useCsrfFetch();

  const fetchStyles = useCallback(async () => {
    try {
      const baseUrl = await api.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/map-styles/styles`);
      if (!response.ok) throw new Error('Failed to fetch styles');
      const data = await response.json();
      setStyles(data);
    } catch (err) {
      console.error('Failed to fetch map styles:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStyles();
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
        const err = await response.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error(err.error ?? 'Upload failed');
      }
      await fetchStyles();
    } catch (err) {
      console.error('Failed to upload map style:', err);
      alert(`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
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
        const err = await response.json().catch(() => ({ error: 'Import failed' }));
        throw new Error(err.error ?? 'Import failed');
      }
      setImportUrl('');
      setImportName('');
      await fetchStyles();
    } catch (err) {
      console.error('Failed to import map style from URL:', err);
      alert(`Import failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setFetchingUrl(false);
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
    if (!confirm(`Delete style "${name}"? This cannot be undone.`)) return;
    try {
      const baseUrl = await api.getBaseUrl();
      const response = await csrfFetch(`${baseUrl}/api/map-styles/styles/${id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Delete failed');
      setStyles(prev => prev.filter(s => s.id !== id));
    } catch (err) {
      console.error('Failed to delete map style:', err);
    }
  };

  if (loading) {
    return <div className="setting-item"><span>Loading map styles...</span></div>;
  }

  return (
    <div>
      <div className="setting-item">
        <label>
          Map Styles
          <span className="setting-description">Upload and manage MapLibre GL style JSON files for vector tile layers.</span>
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {/* File upload */}
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
              }}
            />
            <button
              className="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? 'Uploading...' : 'Upload Style (.json)'}
            </button>
          </div>

          {/* URL import */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="Style URL"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              style={{ flex: 2, minWidth: '160px', padding: '4px 8px', border: '1px solid var(--border-color, #ccc)', borderRadius: '3px', background: 'var(--input-bg, #fff)', color: 'var(--text-color, #000)' }}
            />
            <input
              type="text"
              placeholder="Name (optional)"
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
              style={{ flex: 1, minWidth: '100px', padding: '4px 8px', border: '1px solid var(--border-color, #ccc)', borderRadius: '3px', background: 'var(--input-bg, #fff)', color: 'var(--text-color, #000)' }}
            />
            <button
              className="button"
              onClick={handleFetchUrl}
              disabled={fetchingUrl || !importUrl.trim()}
            >
              {fetchingUrl ? 'Fetching...' : 'Fetch'}
            </button>
          </div>
        </div>
      </div>

      {styles.length === 0 ? (
        <div className="setting-item">
          <span style={{ color: 'var(--text-muted, #888)', fontStyle: 'italic' }}>
            No map styles uploaded yet.
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
                {style.sourceType === 'upload' ? 'Upload' : 'URL'}
              </span>

              {/* Delete */}
              <button
                onClick={() => deleteStyle(style.id, style.name)}
                style={{ padding: '2px 8px', background: 'var(--danger-color, #dc3545)', color: '#fff', border: 'none', borderRadius: '3px', cursor: 'pointer', fontSize: '0.85em' }}
              >
                Delete
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
};

export default MapStyleManager;
