import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSource } from '../contexts/SourceContext';

interface IgnoredNodesSectionProps {
  baseUrl: string;
}

interface IgnoredNode {
  nodeNum: number;
  sourceId: string;
  nodeId: string;
  longName: string | null;
  shortName: string | null;
  ignoredAt: number;
  ignoredBy: string | null;
  reason: 'manual' | 'geo';
}

const IgnoredNodesSection: React.FC<IgnoredNodesSectionProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  // sourceId is optional — when null/undefined the backend falls back to the
  // caller's first permitted source. Explicit per-source lists live under this
  // section once a source is active in <SourceProvider>.
  const { sourceId: currentSourceId } = useSource();

  const [ignoredNodes, setIgnoredNodes] = useState<IgnoredNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [removingNodeNum, setRemovingNodeNum] = useState<number | null>(null);

  const geoCount = ignoredNodes.filter(n => n.reason === 'geo').length;
  const manualCount = ignoredNodes.length - geoCount;

  const sourceQuery = currentSourceId ? `?sourceId=${encodeURIComponent(currentSourceId)}` : '';

  const fetchIgnoredNodes = useCallback(async () => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/ignored-nodes${sourceQuery}`);
      if (response.ok) {
        const data = await response.json();
        setIgnoredNodes(data);
      }
    } catch (error) {
      console.error('Failed to fetch ignored nodes:', error);
    } finally {
      setIsLoading(false);
    }
  }, [baseUrl, csrfFetch, sourceQuery]);

  useEffect(() => {
    void fetchIgnoredNodes();
  }, [fetchIgnoredNodes]);

  const handleRemove = async (node: IgnoredNode) => {
    setRemovingNodeNum(node.nodeNum);
    try {
      // Always target the row's own source — an aggregated list may mix rows
      // from different sources, and we must not collapse that back to the
      // "active" source on delete.
      const deleteQuery = `?sourceId=${encodeURIComponent(node.sourceId)}`;
      const response = await csrfFetch(`${baseUrl}/api/ignored-nodes/${node.nodeId}${deleteQuery}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast(t('automation.insufficient_permissions'), 'error');
          return;
        }
        throw new Error(`Server returned ${response.status}`);
      }

      setIgnoredNodes(prev => prev.filter(n => n.nodeNum !== node.nodeNum));
      showToast(
        t('automation.ignored_nodes.removed', { name: node.longName || node.nodeId }),
        'success'
      );
    } catch (error) {
      console.error('Failed to remove ignored node:', error);
      showToast(t('automation.ignored_nodes.remove_failed'), 'error');
    } finally {
      setRemovingNodeNum(null);
    }
  };

  if (isLoading) {
    return (
      <div className="automation-section-header" style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
      }}>
        {t('common.loading')}...
      </div>
    );
  }

  return (
    <>
      <div className="automation-section-header" style={{
        display: 'flex',
        alignItems: 'center',
        marginBottom: '1.5rem',
        padding: '1rem 1.25rem',
        background: 'var(--color-surface-hover)',
        border: '1px solid var(--color-surface-active)',
        borderRadius: '8px'
      }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {t('automation.ignored_nodes.title', 'Ignored Nodes')}
          <a
            href="https://meshmonitor.org/features/automation#ignored-nodes"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '1.2rem',
              color: '#89b4fa',
              textDecoration: 'none',
              marginLeft: '0.5rem'
            }}
            title={t('automation.view_docs')}
          >
            ?
          </a>
        </h2>
      </div>

      <div className="settings-section">
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          {t('automation.ignored_nodes.description', "Nodes on this list stay ignored permanently. MeshMonitor re-applies the ignored flag automatically whenever a listed node reappears without it — for example after inactive-node cleanup, or when the device's node database fills up and clears the ignore on its own. A blocked node is blocked, not deleted: on firmware 2.8+ it may stop appearing in the device's full node list while still being retained, and it stays on this list either way.")}
        </p>

        {/* Stats */}
        <div style={{
          marginLeft: '1.75rem',
          marginBottom: '1.5rem',
          padding: '1rem',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-surface-active)',
          borderRadius: '6px',
          display: 'flex',
          gap: '2rem',
        }}>
          <div>
            <div style={{ fontSize: '24px', fontWeight: 600, color: 'var(--color-error)' }}>
              {ignoredNodes.length}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--color-text-subtle)' }}>
              {t('automation.ignored_nodes.total_ignored', 'Ignored Nodes')}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--color-text-subtle)', marginTop: '0.25rem' }}>
              {t('automation.ignored_nodes.count_summary', '{{count}} ignored · {{geo}} geo · {{manual}} manual', {
                count: ignoredNodes.length,
                geo: geoCount,
                manual: manualCount,
              })}
            </div>
          </div>
        </div>

        {/* Ignored Nodes Table */}
        <div style={{
          border: '1px solid var(--color-surface-active)',
          borderRadius: '6px',
          overflow: 'hidden',
          marginLeft: '1.75rem'
        }}>
          {ignoredNodes.length === 0 ? (
            <div style={{
              padding: '1rem',
              textAlign: 'center',
              color: 'var(--color-text-subtle)',
              fontSize: '12px'
            }}>
              {t('automation.ignored_nodes.empty', 'No nodes are currently ignored.')}
            </div>
          ) : (
            <table style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '12px'
            }}>
              <thead>
                <tr style={{ background: 'var(--color-surface-hover)' }}>
                  <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
                    {t('automation.ignored_nodes.col_node_id', 'Node ID')}
                  </th>
                  <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
                    {t('automation.ignored_nodes.col_long_name', 'Long Name')}
                  </th>
                  <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
                    {t('automation.ignored_nodes.col_short_name', 'Short Name')}
                  </th>
                  <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
                    {t('automation.ignored_nodes.col_ignored_at', 'Ignored At')}
                  </th>
                  <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
                    {t('automation.ignored_nodes.col_reason', 'Reason')}
                  </th>
                  <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center', fontWeight: 500 }}>
                    {t('automation.ignored_nodes.col_actions', 'Actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {ignoredNodes.map((node) => (
                  <tr key={`${node.sourceId}:${node.nodeNum}`} style={{ borderTop: '1px solid var(--color-surface-hover)' }}>
                    <td style={{ padding: '0.4rem 0.75rem', color: 'var(--color-text)', fontFamily: 'monospace' }}>
                      {node.nodeId}
                    </td>
                    <td style={{ padding: '0.4rem 0.75rem', color: 'var(--color-text)' }}>
                      {node.longName || '-'}
                    </td>
                    <td style={{ padding: '0.4rem 0.75rem', color: 'var(--color-text)' }}>
                      {node.shortName || '-'}
                    </td>
                    <td style={{ padding: '0.4rem 0.75rem', color: 'var(--color-text-subtle)' }}>
                      {new Date(node.ignoredAt).toLocaleString()}
                    </td>
                    <td style={{ padding: '0.4rem 0.75rem' }}>
                      <span style={{
                        fontSize: '11px',
                        padding: '0.15rem 0.4rem',
                        background: node.reason === 'geo' ? 'var(--color-accent)' : 'var(--color-surface-active)',
                        color: node.reason === 'geo' ? 'var(--color-bg)' : 'var(--color-text-subtle)',
                        borderRadius: '4px',
                        fontWeight: 'bold',
                      }}>
                        {node.reason === 'geo'
                          ? t('automation.ignored_nodes.reason_geo', 'Geo filter')
                          : t('automation.ignored_nodes.reason_manual', 'Manual')}
                      </span>
                    </td>
                    <td style={{ padding: '0.4rem 0.75rem', textAlign: 'center' }}>
                      <button
                        onClick={() => handleRemove(node)}
                        disabled={removingNodeNum === node.nodeNum}
                        style={{
                          padding: '0.25rem 0.5rem',
                          fontSize: '11px',
                          background: 'var(--color-error)',
                          color: 'var(--color-bg)',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: removingNodeNum === node.nodeNum ? 'not-allowed' : 'pointer',
                          opacity: removingNodeNum === node.nodeNum ? 0.5 : 1,
                        }}
                      >
                        {removingNodeNum === node.nodeNum
                          ? t('common.loading', 'Loading...')
                          : t('automation.ignored_nodes.unignore', 'Un-ignore')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
};

export default IgnoredNodesSection;
