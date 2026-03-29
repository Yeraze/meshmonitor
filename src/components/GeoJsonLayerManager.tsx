import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { GeoJsonLayer } from '../server/services/geojsonService.js';
import api from '../services/api';
import { useCsrfFetch } from '../hooks/useCsrfFetch';

const GeoJsonLayerManager: React.FC = () => {
  const [layers, setLayers] = useState<GeoJsonLayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csrfFetch = useCsrfFetch();

  const fetchLayers = useCallback(async () => {
    try {
      const baseUrl = await api.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/geojson/layers`);
      if (!response.ok) throw new Error('Failed to fetch layers');
      const data = await response.json();
      setLayers(data);
    } catch (err) {
      console.error('Failed to fetch GeoJSON layers:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLayers();
  }, [fetchLayers]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const baseUrl = await api.getBaseUrl();
      const buffer = await file.arrayBuffer();
      const response = await csrfFetch(`${baseUrl}/api/geojson/upload`, {
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
      await fetchLayers();
    } catch (err) {
      console.error('Failed to upload GeoJSON file:', err);
      alert(`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const updateLayer = async (id: string, updates: Partial<GeoJsonLayer>) => {
    try {
      const baseUrl = await api.getBaseUrl();
      const response = await csrfFetch(`${baseUrl}/api/geojson/layers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!response.ok) throw new Error('Update failed');
      const updated = await response.json();
      setLayers(prev => prev.map(l => l.id === id ? updated : l));
    } catch (err) {
      console.error('Failed to update layer:', err);
    }
  };

  const deleteLayer = async (id: string, name: string) => {
    if (!confirm(`Delete layer "${name}"? This cannot be undone.`)) return;
    try {
      const baseUrl = await api.getBaseUrl();
      const response = await csrfFetch(`${baseUrl}/api/geojson/layers/${id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Delete failed');
      setLayers(prev => prev.filter(l => l.id !== id));
    } catch (err) {
      console.error('Failed to delete layer:', err);
    }
  };

  if (loading) {
    return <div className="setting-item"><span>Loading GeoJSON layers...</span></div>;
  }

  return (
    <div>
      <div className="setting-item">
        <label>
          GeoJSON Layers
          <span className="setting-description">Upload and manage GeoJSON overlay layers on the map.</span>
        </label>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".geojson,.json,.kml,.kmz"
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
            {uploading ? 'Uploading...' : 'Upload Overlay (GeoJSON/KML/KMZ)'}
          </button>
        </div>
      </div>

      {layers.length === 0 ? (
        <div className="setting-item">
          <span style={{ color: 'var(--text-muted, #888)', fontStyle: 'italic' }}>
            No GeoJSON layers uploaded yet.
          </span>
        </div>
      ) : (
        layers.map(layer => (
          <div key={layer.id} className="setting-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%' }}>
              {/* Visibility */}
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={layer.visible}
                  onChange={(e) => updateLayer(layer.id, { visible: e.target.checked })}
                />
                <span style={{ fontSize: '0.85em' }}>Visible</span>
              </label>

              {/* Color */}
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ fontSize: '0.85em' }}>Color</span>
                <input
                  type="color"
                  value={layer.style.color}
                  onChange={(e) => updateLayer(layer.id, { style: { ...layer.style, color: e.target.value } })}
                  style={{ width: '36px', height: '24px', padding: '1px', border: '1px solid var(--border-color, #ccc)', borderRadius: '3px', cursor: 'pointer' }}
                />
              </label>

              {/* Name */}
              <input
                type="text"
                value={layer.name}
                onChange={(e) => setLayers(prev => prev.map(l => l.id === layer.id ? { ...l, name: e.target.value } : l))}
                onBlur={(e) => updateLayer(layer.id, { name: e.target.value })}
                style={{ flex: 1, padding: '2px 6px', border: '1px solid var(--border-color, #ccc)', borderRadius: '3px', background: 'var(--input-bg, #fff)', color: 'var(--text-color, #000)' }}
              />

              {/* Delete */}
              <button
                onClick={() => deleteLayer(layer.id, layer.name)}
                style={{ padding: '2px 8px', background: 'var(--danger-color, #dc3545)', color: '#fff', border: 'none', borderRadius: '3px', cursor: 'pointer', fontSize: '0.85em' }}
              >
                Delete
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', paddingLeft: '4px' }}>
              {/* Opacity */}
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85em' }}>
                Opacity
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={layer.style.opacity}
                  onChange={(e) => updateLayer(layer.id, { style: { ...layer.style, opacity: parseFloat(e.target.value) } })}
                  style={{ width: '80px' }}
                />
                <span>{Math.round(layer.style.opacity * 100)}%</span>
              </label>

              {/* Fill Opacity */}
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85em' }}>
                Fill Opacity
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={layer.style.fillOpacity}
                  onChange={(e) => updateLayer(layer.id, { style: { ...layer.style, fillOpacity: parseFloat(e.target.value) } })}
                  style={{ width: '80px' }}
                />
                <span>{Math.round(layer.style.fillOpacity * 100)}%</span>
              </label>

              {/* Weight */}
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85em' }}>
                Line Width
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={layer.style.weight}
                  onChange={(e) => updateLayer(layer.id, { style: { ...layer.style, weight: parseInt(e.target.value) } })}
                  style={{ width: '50px', padding: '2px 4px', border: '1px solid var(--border-color, #ccc)', borderRadius: '3px', background: 'var(--input-bg, #fff)', color: 'var(--text-color, #000)' }}
                />
              </label>
            </div>
          </div>
        ))
      )}
    </div>
  );
};

export default GeoJsonLayerManager;
