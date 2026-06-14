/**
 * ScriptDependenciesPanel — manage third-party dependencies for user scripts.
 *
 * Reads/installs dependencies declared in the scripts directory's manifests
 * (`requirements.txt` for Python, `package.json` for Node) into directories next
 * to the scripts. Talks to GET /api/scripts/dependencies and
 * POST /api/scripts/dependencies/install. Installing requires `settings:write`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useAuth } from '../../contexts/AuthContext';
import apiService from '../../services/api';

interface KindStatus {
  manifestPresent: boolean;
  installed: boolean;
  packages: string[];
}
interface DependencyStatus {
  python: KindStatus;
  node: KindStatus;
  allowSourceBuilds: boolean;
  scriptsDir: string;
}

const KindRow: React.FC<{ title: string; manifest: string; status: KindStatus }> = ({ title, manifest, status }) => (
  <div style={{ marginBottom: '0.5rem' }}>
    <strong>{title}</strong>{' '}
    <span className="setting-description">
      {status.manifestPresent
        ? `${manifest} found · ${status.packages.length} package(s) installed`
        : `no ${manifest}`}
    </span>
    {status.packages.length > 0 && (
      <div style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)', marginTop: '0.15rem' }}>
        {status.packages.join(', ')}
      </div>
    )}
  </div>
);

const ScriptDependenciesPanel: React.FC = () => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { hasPermission } = useAuth();
  const canInstall = hasPermission('settings', 'write');

  const [status, setStatus] = useState<DependencyStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const baseUrl = await apiService.getBaseUrl();
      const res = await csrfFetch(`${baseUrl}/api/scripts/dependencies`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
    } catch {
      setStatus(null);
    }
  }, [csrfFetch]);

  useEffect(() => { void load(); }, [load]);

  const install = useCallback(async () => {
    setInstalling(true);
    setError(null);
    setLog(null);
    try {
      const baseUrl = await apiService.getBaseUrl();
      const res = await csrfFetch(`${baseUrl}/api/scripts/dependencies/install`, { method: 'POST' });
      const data = await res.json();
      setLog(data.log || '');
      if (!data.success) setError(data.error || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInstalling(false);
    }
  }, [csrfFetch, load]);

  if (!status) return null;

  const nothingDeclared = !status.python.manifestPresent && !status.node.manifestPresent;

  return (
    <div className="setting-item" style={{ marginTop: '1.5rem', borderTop: '1px solid var(--ctp-surface1)', paddingTop: '1rem' }}>
      <h4 style={{ margin: '0 0 0.25rem 0' }}>{t('scripts.deps.title', '📦 Script Dependencies')}</h4>
      <p className="setting-description" style={{ marginTop: 0 }}>
        {t('scripts.deps.description', 'Install Python/Node packages your scripts need. Add a requirements.txt (Python) or package.json (Node) to the scripts directory, then install. Packages are installed next to your scripts and persist across restarts.')}
      </p>

      <KindRow title="Python" manifest="requirements.txt" status={status.python} />
      <KindRow title="Node" manifest="package.json" status={status.node} />

      {nothingDeclared && (
        <p className="setting-description">
          {t('scripts.deps.none', 'No dependency manifest found in the scripts directory yet.')}
        </p>
      )}

      {canInstall && (
        <button
          onClick={() => void install()}
          disabled={installing || nothingDeclared}
          style={{
            marginTop: '0.5rem', padding: '0.4rem 1rem', borderRadius: '4px', border: 'none',
            cursor: installing || nothingDeclared ? 'not-allowed' : 'pointer', fontWeight: 'bold',
            background: installing || nothingDeclared ? 'var(--ctp-surface2)' : 'var(--ctp-blue)',
            color: installing || nothingDeclared ? 'var(--ctp-subtext0)' : 'var(--ctp-base)',
          }}
        >
          {installing ? t('scripts.deps.installing', 'Installing…') : t('scripts.deps.install', '⬇️ Install / Update dependencies')}
        </button>
      )}

      <p className="setting-description" style={{ marginTop: '0.5rem', color: 'var(--ctp-yellow)' }}>
        {t('scripts.deps.warning', '⚠️ Installing downloads and runs third-party code, and requires internet access. On the slim Docker image, packages without a prebuilt musl wheel will fail unless SCRIPT_DEPS_ALLOW_SOURCE_BUILD=true.')}
      </p>

      {error && <div className="settings-error" role="alert" style={{ marginTop: '0.5rem' }}>{error}</div>}

      {log && (
        <pre style={{
          marginTop: '0.5rem', maxHeight: '240px', overflow: 'auto', fontSize: '0.7rem',
          background: 'var(--ctp-mantle)', color: 'var(--ctp-subtext1)', padding: '0.5rem', borderRadius: '4px',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{log}</pre>
      )}
    </div>
  );
};

export default ScriptDependenciesPanel;
