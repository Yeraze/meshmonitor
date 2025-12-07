import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
      alert(t('tileset_manager.save_failed'));
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
    if (!confirm(t('tileset_manager.delete_confirm'))) {
      return;
    }

    try {
      await deleteCustomTileset(id);
    } catch (error) {
      console.error('Failed to delete custom tileset:', error);
      alert(t('tileset_manager.delete_failed'));
    }
  };

  return (
    <div className="custom-tileset-manager">
      <div className="manager-header">
        <h3>{t('tileset_manager.title')}</h3>
        <span className="manager-description">
          {t('tileset_manager.description')}{' '}
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
            {t('tileset_manager.setup_guide')} →
          </a>
        </span>
      </div>

      {customTilesets.length === 0 && !isAdding && !editingId && (
        <div className="no-custom-tilesets">
          <p>{t('tileset_manager.no_tilesets')}</p>
          <p className="hint">
            {t('tileset_manager.no_tilesets_hint')}
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
                      {isVector ? t('tileset_manager.vector') : t('tileset_manager.raster')}
                    </span>
                  </div>
                  <div className="tileset-url">{tileset.url}</div>
                  {tileset.description && (
                    <div className="tileset-description">{tileset.description}</div>
                  )}
                  <div className="tileset-meta">
                    <span>{t('tileset_manager.max_zoom')}: {tileset.maxZoom}</span>
                    <span className="meta-separator">•</span>
                    <span>{t('tileset_manager.attribution')}: {tileset.attribution}</span>
                  </div>
                </div>
                <div className="tileset-actions">
                  <button
                    onClick={() => handleEdit(tileset)}
                    className="btn-edit"
                    disabled={isSaving}
                    title={t('common.edit')}
                  >
                    {t('common.edit')}
                  </button>
                  <button
                    onClick={() => handleDelete(tileset.id)}
                    className="btn-delete"
                    disabled={isSaving}
                    title={t('common.delete')}
                  >
                    {t('common.delete')}
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
            <h4>{editingId ? t('tileset_manager.edit_form_title') : t('tileset_manager.add_form_title')}</h4>
          </div>

          <div className="form-field">
            <label htmlFor="tileset-name">
              {t('tileset_manager.field_name')} <span className="required">*</span>
            </label>
            <input
              id="tileset-name"
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder={t('tileset_manager.name_placeholder')}
              maxLength={100}
              required
              disabled={isSaving}
            />
            <small>{t('tileset_manager.name_help')}</small>
          </div>

          <div className="form-field">
            <label htmlFor="tileset-url">
              {t('tileset_manager.field_url')} <span className="required">*</span>
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
              {t('tileset_manager.url_help')}
            </small>
            <small className="example">
              {t('tileset_manager.url_example_raster')}
            </small>
            <small className="example">
              {t('tileset_manager.url_example_vector')}
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
                💡 {t('tileset_manager.tileserver_tip_title')}
              </strong>
              <div style={{ color: 'var(--ctp-subtext0)', lineHeight: '1.5' }}>
                {t('tileset_manager.tileserver_tip_desc')}
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
                  <strong>{t('tileset_manager.tileserver_tip_support')}</strong>
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
                    {t('tileset_manager.tileserver_tip_link')} →
                  </a>
                </div>
              </div>
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="tileset-attribution">
              {t('tileset_manager.field_attribution')} <span className="required">*</span>
            </label>
            <input
              id="tileset-attribution"
              type="text"
              value={formData.attribution}
              onChange={(e) => setFormData({ ...formData, attribution: e.target.value })}
              placeholder={t('tileset_manager.attribution_placeholder')}
              maxLength={200}
              required
              disabled={isSaving}
            />
            <small>{t('tileset_manager.attribution_help')}</small>
          </div>

          <div className="form-field">
            <label htmlFor="tileset-maxzoom">
              {t('tileset_manager.field_max_zoom')} <span className="required">*</span>
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
            <small>{t('tileset_manager.max_zoom_help')}</small>
          </div>

          <div className="form-field">
            <label htmlFor="tileset-description">
              {t('tileset_manager.field_description')}
            </label>
            <input
              id="tileset-description"
              type="text"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder={t('tileset_manager.description_placeholder')}
              maxLength={200}
              disabled={isSaving}
            />
            <small>{t('tileset_manager.description_help')}</small>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn-save" disabled={isSaving}>
              {isSaving ? t('common.saving') : t('common.save')}
            </button>
            <button
              type="button"
              className="btn-cancel"
              onClick={handleCancel}
              disabled={isSaving}
            >
              {t('common.cancel')}
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
          + {t('tileset_manager.add_button')}
        </button>
      )}
    </div>
  );
}
