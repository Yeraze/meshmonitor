import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';

interface IgnoredNodesSectionProps {
  baseUrl: string;
}

interface IgnoredNode {
  nodeNum: number;
  nodeId: string;
  longName: string | null;
  shortName: string | null;
  ignoredAt: number;
  ignoredBy: string | null;
}

const IgnoredNodesSection: React.FC<IgnoredNodesSectionProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();

  const [ignoredNodes, setIgnoredNodes] = useState<IgnoredNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [removingNodeNum, setRemovingNodeNum] = useState<number | null>(null);

  const fetchIgnoredNodes = useCallback(async () => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/ignored-nodes`);
      if (response.ok) {
        const data = await response.json();
        setIgnoredNodes(data);
      }
    } catch (error) {
      console.error('Failed to fetch ignored nodes:', error);
    } finally {
      setIsLoading(false);
    }
  }, [baseUrl, csrfFetch]);

  useEffect(() => {
    fetchIgnoredNodes();
  }, [fetchIgnoredNodes]);

  const handleRemove = async (node: IgnoredNode) => {
    setRemovingNodeNum(node.nodeNum);
    try {
      const response = await csrfFetch(`${baseUrl}/api/ignored-nodes/${node.nodeId}`, {
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
        background: 'var(--ctp-surface1)',
        border: '1px solid var(--ctp-surface2)',
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
          {t('automation.ignored_nodes.description', 'Nodes on this list will remain ignored even after being pruned by inactive node cleanup. When they reappear, their ignored status will be automatically restored.')}
        </p>

        {/* Stats */}
        <div style={{
          marginLeft: '1.75rem',
          marginBottom: '1.5rem',
          padding: '1rem',
          background: 'var(--ctp-surface0)',
          border: '1px solid var(--ctp-surface2)',
          borderRadius: '6px',
          display: 'flex',
          gap: '2rem',
        }}>
          <div>
            <div style={{ fontSize: '24px', fontWeight: 600, color: 'var(--ctp-red)' }}>
              {ignoredNodes.length}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--ctp-subtext0)' }}>
              {t('automation.ignored_nodes.total_ignored', 'Ignored Nodes')}
            </div>
          </div>
        </div>

        {/* Ignored Nodes Table */}
        <div style={{
          border: '1px solid var(--ctp-surface2)',
          borderRadius: '6px',
          overflow: 'hidden',
          marginLeft: '1.75rem'
        }}>
          {ignoredNodes.length === 0 ? (
            <div style={{
              padding: '1rem',
              textAlign: 'center',
              color: 'var(--ctp-subtext0)',
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
                <tr style={{ background: 'var(--ctp-surface1)' }}>
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
                  <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center', fontWeight: 500 }}>
                    {t('automation.ignored_nodes.col_actions', 'Actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {ignoredNodes.map((node) => (
                  <tr key={node.nodeNum} style={{ borderTop: '1px solid var(--ctp-surface1)' }}>
                    <td style={{ padding: '0.4rem 0.75rem', color: 'var(--ctp-text)', fontFamily: 'monospace' }}>
                      {node.nodeId}
                    </td>
                    <td style={{ padding: '0.4rem 0.75rem', color: 'var(--ctp-text)' }}>
                      {node.longName || '-'}
                    </td>
                    <td style={{ padding: '0.4rem 0.75rem', color: 'var(--ctp-text)' }}>
                      {node.shortName || '-'}
                    </td>
                    <td style={{ padding: '0.4rem 0.75rem', color: 'var(--ctp-subtext0)' }}>
                      {new Date(node.ignoredAt).toLocaleString()}
                    </td>
                    <td style={{ padding: '0.4rem 0.75rem', textAlign: 'center' }}>
                      <button
                        onClick={() => handleRemove(node)}
                        disabled={removingNodeNum === node.nodeNum}
                        style={{
                          padding: '0.25rem 0.5rem',
                          fontSize: '11px',
                          background: 'var(--ctp-red)',
                          color: 'var(--ctp-base)',
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
