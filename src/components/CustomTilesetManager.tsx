import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../contexts/SettingsContext';
import { validateTileUrl, isVectorTileUrl, type CustomTileset } from '../config/tilesets';
import { testTileServer, formatTileSize, autodetectTileServer, type TileTestResult, type AutodetectResult, type AutodetectProgress } from '../utils/tileServerTest';
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
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<TileTestResult | null>(null);
  const [isAutodetecting, setIsAutodetecting] = useState(false);
  const [autodetectProgress, setAutodetectProgress] = useState<AutodetectProgress | null>(null);
  const [autodetectResult, setAutodetectResult] = useState<AutodetectResult | null>(null);
  const [autodetectBaseUrl, setAutodetectBaseUrl] = useState('');
  const [showReloadNotice, setShowReloadNotice] = useState(false);

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
    setTestResult(null); // Clear test results when URL changes
    if (url.trim()) {
      const validation = validateTileUrl(url);
      setUrlValidation(validation);
    } else {
      setUrlValidation(null);
    }
  };

  const handleTestConnection = async () => {
    if (!formData.url.trim() || !urlValidation?.valid) {
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      const result = await testTileServer(formData.url);
      setTestResult(result);
    } catch (error) {
      console.error('Test failed:', error);
      setTestResult({
        success: false,
        status: 'error',
        tileType: 'unknown',
        message: 'Test failed unexpectedly',
        errors: [error instanceof Error ? error.message : 'Unknown error'],
        warnings: [],
        details: {}
      });
    } finally {
      setIsTesting(false);
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
      setShowReloadNotice(true);
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
    setTestResult(null);
    setAutodetectResult(null);
    setAutodetectBaseUrl('');
  };

  const handleAutodetect = async () => {
    if (!autodetectBaseUrl.trim()) {
      return;
    }

    setIsAutodetecting(true);
    setAutodetectProgress(null);
    setAutodetectResult(null);
    setTestResult(null);

    try {
      const result = await autodetectTileServer(
        autodetectBaseUrl,
        (progress) => setAutodetectProgress(progress)
      );
      setAutodetectResult(result);
    } catch (error) {
      console.error('Autodetect failed:', error);
      setAutodetectResult({
        success: false,
        detectedUrls: [],
        baseUrl: autodetectBaseUrl,
        testedPatterns: 0,
        errors: [error instanceof Error ? error.message : 'Unknown error']
      });
    } finally {
      setIsAutodetecting(false);
      setAutodetectProgress(null);
    }
  };

  const handleSelectAutodetectedUrl = (url: string) => {
    setFormData({ ...formData, url });
    handleUrlChange(url);
    setAutodetectResult(null);
    setAutodetectBaseUrl('');
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

      {showReloadNotice && (
        <div className="reload-notice">
          <div className="reload-notice-content">
            <span className="reload-notice-icon">⚠️</span>
            <span className="reload-notice-text">{t('tileset_manager.reload_required')}</span>
            <button
              className="btn-reload"
              onClick={() => window.location.reload()}
            >
              {t('tileset_manager.reload_now')}
            </button>
            <button
              className="btn-dismiss"
              onClick={() => setShowReloadNotice(false)}
              title={t('common.dismiss')}
            >
              ✕
            </button>
          </div>
        </div>
      )}

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
            <div className="url-input-row">
              <input
                id="tileset-url"
                type="text"
                value={formData.url}
                onChange={(e) => handleUrlChange(e.target.value)}
                placeholder="https://example.com/{z}/{x}/{y}.png"
                maxLength={500}
                required
                disabled={isSaving || isTesting}
                className={urlValidation && !urlValidation.valid ? 'error' : ''}
              />
              <button
                type="button"
                className="btn-test"
                onClick={handleTestConnection}
                disabled={isSaving || isTesting || !urlValidation?.valid}
                title={t('tileset_manager.test_button_title')}
              >
                {isTesting ? t('tileset_manager.testing') : t('tileset_manager.test_button')}
              </button>
            </div>
            {urlValidation && urlValidation.error && (
              <div className={`validation-message ${urlValidation.valid ? 'warning' : 'error'}`}>
                {urlValidation.error}
              </div>
            )}

            {/* Autodetect Section */}
            <div className="autodetect-section">
              <div className="autodetect-header">
                <span className="autodetect-icon">🔍</span>
                <span>{t('tileset_manager.autodetect_title')}</span>
              </div>
              <div className="autodetect-input-row">
                <input
                  type="text"
                  value={autodetectBaseUrl}
                  onChange={(e) => setAutodetectBaseUrl(e.target.value)}
                  placeholder={t('tileset_manager.autodetect_placeholder')}
                  disabled={isSaving || isAutodetecting}
                />
                <button
                  type="button"
                  className="btn-autodetect"
                  onClick={handleAutodetect}
                  disabled={isSaving || isAutodetecting || !autodetectBaseUrl.trim()}
                >
                  {isAutodetecting ? t('tileset_manager.autodetecting') : t('tileset_manager.autodetect_button')}
                </button>
              </div>
              <small>{t('tileset_manager.autodetect_help')}</small>

              {/* Autodetect Progress */}
              {isAutodetecting && autodetectProgress && (
                <div className="autodetect-progress">
                  <div className="progress-bar">
                    <div
                      className="progress-fill"
                      style={{ width: `${(autodetectProgress.current / autodetectProgress.total) * 100}%` }}
                    />
                  </div>
                  <div className="progress-text">
                    {t('tileset_manager.autodetect_testing', {
                      current: autodetectProgress.current,
                      total: autodetectProgress.total
                    })}
                  </div>
                </div>
              )}

              {/* Autodetect Results */}
              {autodetectResult && (
                <div className={`autodetect-result ${autodetectResult.success ? 'success' : 'error'}`}>
                  {autodetectResult.success ? (
                    <>
                      <div className="autodetect-result-header">
                        ✅ {t('tileset_manager.autodetect_found', { count: autodetectResult.detectedUrls.length })}
                      </div>
                      <div className="autodetect-url-list">
                        {autodetectResult.detectedUrls.map((detected, index) => (
                          <div key={index} className="autodetect-url-item">
                            <div className="autodetect-url-info">
                              <span className={`tileset-badge ${detected.type}`}>
                                {detected.type === 'vector' ? t('tileset_manager.vector') : t('tileset_manager.raster')}
                              </span>
                              <span className="autodetect-url-text">{detected.url}</span>
                            </div>
                            <button
                              type="button"
                              className="btn-use-url"
                              onClick={() => handleSelectAutodetectedUrl(detected.url)}
                            >
                              {t('tileset_manager.use_this_url')}
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="autodetect-result-header">
                        ❌ {t('tileset_manager.autodetect_none_found')}
                      </div>
                      {autodetectResult.errors.map((error, i) => (
                        <div key={i} className="autodetect-error">{error}</div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            {testResult && (
              <div className={`test-result test-result-${testResult.status}`}>
                <div className="test-result-header">
                  <span className="test-result-icon">
                    {testResult.status === 'success' ? '✅' : testResult.status === 'warning' ? '⚠️' : '❌'}
                  </span>
                  <span className="test-result-message">{testResult.message}</span>
                  {testResult.details.responseTime && (
                    <span className="test-result-time">({testResult.details.responseTime}ms)</span>
                  )}
                </div>
                {testResult.details.tileSize && (
                  <div className="test-result-detail">
                    {t('tileset_manager.test_tile_type')}: {testResult.tileType === 'vector' ? t('tileset_manager.vector') : t('tileset_manager.raster')}
                    {' • '}
                    {t('tileset_manager.test_tile_size')}: {formatTileSize(testResult.details.tileSize)}
                  </div>
                )}
                {testResult.details.matchedLayers && testResult.details.matchedLayers.length > 0 && (
                  <div className="test-result-layers">
                    <div className="layers-matched">
                      ✓ {t('tileset_manager.test_matched_layers')}: {testResult.details.matchedLayers.join(', ')}
                    </div>
                  </div>
                )}
                {testResult.details.missingLayers && testResult.details.missingLayers.length > 0 && (
                  <div className="test-result-layers">
                    <div className="layers-missing">
                      ✗ {t('tileset_manager.test_missing_layers')}: {testResult.details.missingLayers.join(', ')}
                    </div>
                  </div>
                )}
                {testResult.warnings.map((warning, i) => (
                  <div key={i} className="test-result-warning">{warning}</div>
                ))}
                {testResult.errors.map((error, i) => (
                  <div key={i} className="test-result-error">{error}</div>
                ))}
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
