import React, { useState } from 'react';
import { useSettings } from '../contexts/SettingsContext';
import { validateTileUrl, isVectorTileUrl, type CustomTileset } from '../config/tilesets';
import './CustomTilesetManager.css';

interface FormData {
  name: string;
  url: string;
  attribution: string;
  maxZoom: number;
  description: string;
}

const DEFAULT_FORM_DATA: FormData = {
  name: '',
  url: '',
  attribution: '',
  maxZoom: 18,
  description: ''
};

export function CustomTilesetManager() {
  const { customTilesets, addCustomTileset, updateCustomTileset, deleteCustomTileset } = useSettings();
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<FormData>(DEFAULT_FORM_DATA);
  const [urlValidation, setUrlValidation] = useState<{ valid: boolean; error?: string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const validateForm = (): boolean => {
    if (!formData.name.trim()) {
      return false;
    }

    if (!formData.url.trim()) {
      return false;
    }

    const validation = validateTileUrl(formData.url);
    setUrlValidation(validation);

    return validation.valid;
  };

  const handleUrlChange = (url: string) => {
    setFormData({ ...formData, url });
    if (url.trim()) {
      const validation = validateTileUrl(url);
      setUrlValidation(validation);
    } else {
      setUrlValidation(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    setIsSaving(true);
    try {
      if (editingId) {
        await updateCustomTileset(editingId, formData);
        setEditingId(null);
      } else {
        await addCustomTileset(formData);
        setIsAdding(false);
      }

      setFormData(DEFAULT_FORM_DATA);
      setUrlValidation(null);
    } catch (error) {
      console.error('Failed to save custom tileset:', error);
      alert('Failed to save custom tileset. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setIsAdding(false);
    setEditingId(null);
    setFormData(DEFAULT_FORM_DATA);
    setUrlValidation(null);
  };

  const handleEdit = (tileset: CustomTileset) => {
    setFormData({
      name: tileset.name,
      url: tileset.url,
      attribution: tileset.attribution,
      maxZoom: tileset.maxZoom,
      description: tileset.description
    });
    setEditingId(tileset.id);
    setIsAdding(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this custom tileset?')) {
      return;
    }

    try {
      await deleteCustomTileset(id);
    } catch (error) {
      console.error('Failed to delete custom tileset:', error);
      alert('Failed to delete custom tileset. Please try again.');
    }
  };

  return (
    <div className="custom-tileset-manager">
      <div className="manager-header">
        <h3>Custom Tile Servers</h3>
        <span className="manager-description">
          Add custom tile servers for offline maps or custom styling.{' '}
          <a
            href="https://meshmonitor.org/features/maps"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: 'var(--ctp-blue)',
              textDecoration: 'underline',
              fontWeight: '500'
            }}
          >
            View setup guide →
          </a>
        </span>
      </div>

      {customTilesets.length === 0 && !isAdding && !editingId && (
        <div className="no-custom-tilesets">
          <p>No custom tile servers configured.</p>
          <p className="hint">
            Configure a local tile server (like TileServer GL) or use a custom hosted service.
          </p>
        </div>
      )}

      {customTilesets.length > 0 && !editingId && (
        <div className="tileset-list">
          {customTilesets.map(tileset => {
            const isVector = tileset.isVector ?? isVectorTileUrl(tileset.url);
            return (
              <div key={tileset.id} className="tileset-item">
                <div className="tileset-info">
                  <div className="tileset-header">
                    <div className="tileset-name">{tileset.name}</div>
                    <span className={`tileset-badge ${isVector ? 'vector' : 'raster'}`}>
                      {isVector ? 'Vector' : 'Raster'}
                    </span>
                  </div>
                  <div className="tileset-url">{tileset.url}</div>
                  {tileset.description && (
                    <div className="tileset-description">{tileset.description}</div>
                  )}
                  <div className="tileset-meta">
                    <span>Max Zoom: {tileset.maxZoom}</span>
                    <span className="meta-separator">•</span>
                    <span>Attribution: {tileset.attribution}</span>
                  </div>
                </div>
                <div className="tileset-actions">
                  <button
                    onClick={() => handleEdit(tileset)}
                    className="btn-edit"
                    disabled={isSaving}
                    title="Edit tileset"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(tileset.id)}
                    className="btn-delete"
                    disabled={isSaving}
                    title="Delete tileset"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(isAdding || editingId) && (
        <form onSubmit={handleSubmit} className="tileset-form">
          <div className="form-header">
            <h4>{editingId ? 'Edit Custom Tile Server' : 'Add Custom Tile Server'}</h4>
          </div>

          <div className="form-field">
            <label htmlFor="tileset-name">
              Name <span className="required">*</span>
            </label>
            <input
              id="tileset-name"
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="My Custom Tiles"
              maxLength={100}
              required
              disabled={isSaving}
            />
            <small>A friendly name for this tile server (max 100 characters)</small>
          </div>

          <div className="form-field">
            <label htmlFor="tileset-url">
              Tile URL <span className="required">*</span>
            </label>
            <input
              id="tileset-url"
              type="text"
              value={formData.url}
              onChange={(e) => handleUrlChange(e.target.value)}
              placeholder="https://example.com/{z}/{x}/{y}.png"
              maxLength={500}
              required
              disabled={isSaving}
              className={urlValidation && !urlValidation.valid ? 'error' : ''}
            />
            {urlValidation && urlValidation.error && (
              <div className={`validation-message ${urlValidation.valid ? 'warning' : 'error'}`}>
                {urlValidation.error}
              </div>
            )}
            <small>
              Must include {'{z}'}, {'{x}'}, {'{y}'} placeholders. Optional: {'{s}'} for subdomains
            </small>
            <small className="example">
              Raster: http://localhost:8080/styles/osm-bright/{'{z}/{x}/{y}'}.png
            </small>
            <small className="example">
              Vector: http://localhost:8080/data/v3/{'{z}/{x}/{y}'}.pbf
            </small>
            <div style={{
              marginTop: '0.75rem',
              padding: '0.75rem',
              backgroundColor: 'var(--ctp-surface0)',
              borderLeft: '3px solid var(--ctp-blue)',
              borderRadius: '4px',
              fontSize: '0.85rem'
            }}>
              <strong style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--ctp-blue)' }}>
                💡 TileServer GL Light (Recommended for Offline Maps)
              </strong>
              <div style={{ color: 'var(--ctp-subtext0)', lineHeight: '1.5' }}>
                For offline operation, use <strong>TileServer GL Light</strong> with .mbtiles files:
                <br />
                <code style={{
                  display: 'block',
                  marginTop: '0.5rem',
                  padding: '0.25rem 0.5rem',
                  backgroundColor: 'var(--ctp-base)',
                  borderRadius: '3px',
                  fontSize: '0.8rem'
                }}>
                  docker run -p 8080:8080 -v /path/to/tiles:/data maptiler/tileserver-gl-light
                </code>
                <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--ctp-subtext1)' }}>
                  <strong>Supports both vector (.pbf) and raster (.png) tiles.</strong> Light version has no native dependencies and runs on all platforms.
                </div>
                <div style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                  <a
                    href="https://meshmonitor.org/features/maps"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: 'var(--ctp-blue)',
                      textDecoration: 'underline'
                    }}
                  >
                    View complete setup guide with Docker Compose configurator →
                  </a>
                </div>
              </div>
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="tileset-attribution">
              Attribution <span className="required">*</span>
            </label>
            <input
              id="tileset-attribution"
              type="text"
              value={formData.attribution}
              onChange={(e) => setFormData({ ...formData, attribution: e.target.value })}
              placeholder="Map data © Your Organization"
              maxLength={200}
              required
              disabled={isSaving}
            />
            <small>Attribution text to display on the map (max 200 characters)</small>
          </div>

          <div className="form-field">
            <label htmlFor="tileset-maxzoom">
              Max Zoom <span className="required">*</span>
            </label>
            <input
              id="tileset-maxzoom"
              type="number"
              value={formData.maxZoom}
              onChange={(e) => setFormData({ ...formData, maxZoom: parseInt(e.target.value) || 18 })}
              min={1}
              max={22}
              required
              disabled={isSaving}
            />
            <small>Maximum zoom level (1-22)</small>
          </div>

          <div className="form-field">
            <label htmlFor="tileset-description">
              Description
            </label>
            <input
              id="tileset-description"
              type="text"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Custom offline tiles for field deployment"
              maxLength={200}
              disabled={isSaving}
            />
            <small>Optional description (max 200 characters)</small>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn-save" disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              className="btn-cancel"
              onClick={handleCancel}
              disabled={isSaving}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {!isAdding && !editingId && (
        <button
          onClick={() => setIsAdding(true)}
          className="btn-add-tileset"
          disabled={isSaving}
        >
          + Add Custom Tile Server
        </button>
      )}
    </div>
  );
}
