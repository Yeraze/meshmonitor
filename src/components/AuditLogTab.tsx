/**
 * Audit Log Tab Component
 *
 * Admin-only interface for viewing and filtering audit logs
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { logger } from '../utils/logger';
import { useToast } from './ToastContainer';

interface AuditLogEntry {
  id: number;
  userId: number | null;
  username: string | null;
  action: string;
  resource: string | null;
  details: string | null;
  ipAddress: string | null;
  valueBefore: string | null;
  valueAfter: string | null;
  timestamp: number;
}

interface AuditStats {
  actionStats: Array<{ action: string; count: number }>;
  userStats: Array<{ username: string | null; count: number }>;
  dailyStats: Array<{ date: string; count: number }>;
  totalEvents: number;
}

interface User {
  id: number;
  username: string;
}

const AuditLogTab: React.FC = () => {
  const { t } = useTranslation();
  const { authStatus } = useAuth();
  const { showToast } = useToast();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [expandedLog, setExpandedLog] = useState<number | null>(null);

  // Filters
  const [filters, setFilters] = useState({
    userId: '',
    action: '',
    source: '',
    resource: '',
    search: '',
    startDate: '',
    endDate: '',
    limit: 100,
    offset: 0
  });

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = filters.limit;

  useEffect(() => {
    fetchLogs();
    fetchStats();
    fetchUsers();
  }, [filters]);

  const fetchLogs = async () => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams();
      if (filters.userId) params.append('userId', filters.userId);
      if (filters.action) params.append('action', filters.action);
      if (filters.source === 'ui') params.append('excludeAction', 'api_token_used');
      if (filters.source === 'api') params.append('action', 'api_token_used');
      if (filters.resource) params.append('resource', filters.resource);
      if (filters.search) params.append('search', filters.search);
      if (filters.startDate) {
        const startTimestamp = new Date(filters.startDate).getTime();
        params.append('startDate', startTimestamp.toString());
      }
      if (filters.endDate) {
        const endDate = new Date(filters.endDate);
        endDate.setHours(23, 59, 59, 999); // End of day
        params.append('endDate', endDate.getTime().toString());
      }
      params.append('limit', filters.limit.toString());
      params.append('offset', filters.offset.toString());

      const response = await api.get<{ logs: AuditLogEntry[]; total: number }>(
        `/api/audit?${params.toString()}`
      );
      setLogs(response.logs);
      setTotal(response.total);
    } catch (err) {
      logger.error('Failed to fetch audit logs:', err);
      setError(t('audit.failed_load'));
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const response = await api.get<{ stats: AuditStats }>('/api/audit/stats/summary?days=30');
      setStats(response.stats);
    } catch (err) {
      logger.error('Failed to fetch audit stats:', err);
    }
  };

  const fetchUsers = async () => {
    try {
      const response = await api.get<{ users: User[] }>('/api/users');
      setUsers(response.users);
    } catch (err) {
      logger.error('Failed to fetch users:', err);
    }
  };

  const handleFilterChange = (key: string, value: string | number) => {
    setFilters(prev => ({
      ...prev,
      [key]: value,
      offset: key !== 'offset' ? 0 : (typeof value === 'number' ? value : 0) // Reset to first page when filters change
    }));
    if (key !== 'offset') {
      setCurrentPage(1);
    }
  };

  const handleClearFilters = () => {
    setFilters({
      userId: '',
      action: '',
      source: '',
      resource: '',
      search: '',
      startDate: '',
      endDate: '',
      limit: 100,
      offset: 0
    });
    setCurrentPage(1);
  };

  const handlePageChange = (newPage: number) => {
    const newOffset = (newPage - 1) * itemsPerPage;
    setFilters(prev => ({ ...prev, offset: newOffset }));
    setCurrentPage(newPage);
  };

  const handleExportCSV = () => {
    try {
      const csvContent = [
        // Header
        ['Timestamp', 'User', 'Action', 'Resource', 'Details', 'IP Address'].join(','),
        // Data rows
        ...logs.map(log => {
          // PostgreSQL returns BIGINT as string, so ensure it's a number
          const ts = typeof log.timestamp === 'string' ? parseInt(log.timestamp, 10) : log.timestamp;
          const dateStr = (!ts || isNaN(ts)) ? 'Unknown' : new Date(ts).toISOString();
          return [
            dateStr,
            log.username || 'System',
            log.action,
            log.resource || '',
            (log.details || '').replace(/,/g, ';'), // Escape commas
            log.ipAddress || ''
          ].join(',');
        })
      ].join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `audit-log-${new Date().toISOString()}.csv`;
      link.click();
      URL.revokeObjectURL(url);

      showToast(t('audit.export_success'), 'success');
    } catch (err) {
      logger.error('Failed to export CSV:', err);
      showToast(t('audit.export_failed'), 'error');
    }
  };

  const formatTimestamp = (timestamp: number | string | null | undefined) => {
    if (timestamp === null || timestamp === undefined) {
      return t('common.unknown');
    }
    // PostgreSQL returns BIGINT as string, so ensure it's a number
    const ts = typeof timestamp === 'string' ? parseInt(timestamp, 10) : timestamp;
    if (isNaN(ts)) {
      return t('common.unknown');
    }
    const date = new Date(ts);
    if (isNaN(date.getTime())) {
      return t('common.unknown');
    }
    return date.toLocaleString();
  };

  const getActionColor = (action: string): string => {
    if (action.includes('fail') || action.includes('delete') || action.includes('purge')) {
      return 'action-error';
    }
    if (action.includes('update') || action.includes('change') || action.includes('reset')) {
      return 'action-warning';
    }
    if (action.includes('success') || action.includes('create')) {
      return 'action-success';
    }
    return '';
  };

  const toggleExpand = (logId: number) => {
    setExpandedLog(expandedLog === logId ? null : logId);
  };

  const totalPages = Math.ceil(total / itemsPerPage);

  // Unique actions and resources for dropdowns
  const uniqueActions = Array.from(new Set(stats?.actionStats.map(s => s.action) || []));
  const uniqueResources = ['auth', 'users', 'permissions', 'settings', 'nodes', 'messages', 'telemetry', 'connection', 'audit'];

  if (!authStatus?.permissions?.audit?.read) {
    return (
      <div className="audit-log-tab">
        <div className="error-message">
          {t('audit.no_permission')}
        </div>
      </div>
    );
  }

  return (
    <div className="audit-log-tab">
      <div className="audit-log-header">
        <h2>{t('audit.title')}</h2>
        <button
          onClick={handleExportCSV}
          className="button button-primary"
          disabled={!logs || logs.length === 0}
        >
          {t('audit.export_csv')}
        </button>
      </div>

      {/* Statistics Summary */}
      {stats && (
        <div className="audit-stats">
          <div className="stat-card">
            <h3>{t('audit.total_events_30_days')}</h3>
            <p className="stat-value">{stats.totalEvents}</p>
          </div>
          <div className="stat-card">
            <h3>{t('audit.top_action')}</h3>
            <p className="stat-label">
              {stats.actionStats[0]?.action || t('audit.na')} ({stats.actionStats[0]?.count || 0})
            </p>
          </div>
          <div className="stat-card">
            <h3>{t('audit.most_active_user')}</h3>
            <p className="stat-label">
              {stats.userStats[0]?.username || t('audit.na')} ({stats.userStats[0]?.count || 0})
            </p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="audit-filters">
        <h3>{t('audit.filters')}</h3>
        <div className="filter-grid">
          <div className="form-group">
            <label htmlFor="filter-user">{t('audit.user')}</label>
            <select
              id="filter-user"
              value={filters.userId}
              onChange={(e) => handleFilterChange('userId', e.target.value)}
            >
              <option value="">{t('audit.all_users')}</option>
              {users && users.map(user => (
                <option key={user.id} value={user.id}>{user.username}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="filter-source">{t('audit.source')}</label>
            <select
              id="filter-source"
              value={filters.source}
              onChange={(e) => handleFilterChange('source', e.target.value)}
            >
              <option value="">{t('audit.all_sources')}</option>
              <option value="ui">{t('audit.ui_only')}</option>
              <option value="api">{t('audit.api_only')}</option>
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="filter-action">{t('audit.action')}</label>
            <select
              id="filter-action"
              value={filters.action}
              onChange={(e) => handleFilterChange('action', e.target.value)}
            >
              <option value="">{t('audit.all_actions')}</option>
              {uniqueActions.map(action => (
                <option key={action} value={action}>{action}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="filter-resource">{t('audit.resource')}</label>
            <select
              id="filter-resource"
              value={filters.resource}
              onChange={(e) => handleFilterChange('resource', e.target.value)}
            >
              <option value="">{t('audit.all_resources')}</option>
              {uniqueResources.map(resource => (
                <option key={resource} value={resource}>{resource}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="filter-start-date">{t('audit.start_date')}</label>
            <input
              id="filter-start-date"
              type="date"
              value={filters.startDate}
              onChange={(e) => handleFilterChange('startDate', e.target.value)}
            />
          </div>

          <div className="form-group">
            <label htmlFor="filter-end-date">{t('audit.end_date')}</label>
            <input
              id="filter-end-date"
              type="date"
              value={filters.endDate}
              onChange={(e) => handleFilterChange('endDate', e.target.value)}
            />
          </div>

          <div className="form-group">
            <label htmlFor="filter-search">{t('audit.search')}</label>
            <input
              id="filter-search"
              type="text"
              placeholder={t('audit.search_placeholder')}
              value={filters.search}
              onChange={(e) => handleFilterChange('search', e.target.value)}
            />
          </div>
        </div>

        <div className="filter-actions">
          <button
            onClick={handleClearFilters}
            className="button button-secondary"
          >
            {t('audit.clear_filters')}
          </button>
          <div className="form-group inline-group">
            <label>{t('audit.per_page')}</label>
            <select
              value={filters.limit}
              onChange={(e) => handleFilterChange('limit', parseInt(e.target.value))}
            >
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
            </select>
          </div>
        </div>
      </div>

      {/* Audit Log Table */}
      {loading ? (
        <div className="audit-loading">{t('audit.loading')}</div>
      ) : error ? (
        <div className="error-message">{error}</div>
      ) : !logs || logs.length === 0 ? (
        <div className="audit-empty">{t('audit.no_entries')}</div>
      ) : (
        <>
          <div className="audit-table-container">
            <table className="audit-table">
              <thead>
                <tr>
                  <th>{t('audit.timestamp')}</th>
                  <th>{t('audit.user')}</th>
                  <th>{t('audit.action')}</th>
                  <th>{t('audit.resource')}</th>
                  <th>{t('audit.ip_address')}</th>
                  <th>{t('audit.details')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => (
                  <React.Fragment key={log.id}>
                    <tr className="audit-row" onClick={() => toggleExpand(log.id)}>
                      <td className="timestamp-cell">
                        {formatTimestamp(log.timestamp)}
                      </td>
                      <td>
                        {log.username || <span className="system-label">{t('audit.system')}</span>}
                      </td>
                      <td className={`action-cell ${getActionColor(log.action)}`}>
                        {log.action}
                      </td>
                      <td>
                        {log.resource || '-'}
                      </td>
                      <td>
                        {log.ipAddress || '-'}
                      </td>
                      <td>
                        <div className="details-cell">
                          {log.details || '-'}
                        </div>
                      </td>
                    </tr>
                    {expandedLog === log.id && (
                      <tr className="audit-detail-row">
                        <td colSpan={6}>
                          <div className="audit-details">
                            <div className="detail-section">
                              <strong>{t('audit.details')}:</strong>
                              <pre className="detail-pre">
                                {log.details ? (() => {
                                  try {
                                    return JSON.stringify(JSON.parse(log.details), null, 2);
                                  } catch {
                                    return log.details;
                                  }
                                })() : t('audit.na')}
                              </pre>
                            </div>
                            {(log.valueBefore || log.valueAfter) && (
                              <div className="detail-comparison">
                                {log.valueBefore && (
                                  <div className="detail-section before">
                                    <strong>{t('audit.value_before')}</strong>
                                    <pre className="detail-pre">
                                      {(() => {
                                        try {
                                          return JSON.stringify(JSON.parse(log.valueBefore), null, 2);
                                        } catch {
                                          return log.valueBefore;
                                        }
                                      })()}
                                    </pre>
                                  </div>
                                )}
                                {log.valueAfter && (
                                  <div className="detail-section after">
                                    <strong>{t('audit.value_after')}</strong>
                                    <pre className="detail-pre">
                                      {(() => {
                                        try {
                                          return JSON.stringify(JSON.parse(log.valueAfter), null, 2);
                                        } catch {
                                          return log.valueAfter;
                                        }
                                      })()}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="audit-pagination">
              <div className="pagination-info">
                {t('audit.showing', { start: filters.offset + 1, end: Math.min(filters.offset + itemsPerPage, total), total })}
              </div>
              <div className="pagination-controls">
                <button
                  onClick={() => handlePageChange(currentPage - 1)}
                  disabled={currentPage === 1}
                  className="button"
                >
                  {t('audit.previous')}
                </button>
                <span className="page-indicator">
                  {t('audit.page', { current: currentPage, total: totalPages })}
                </span>
                <button
                  onClick={() => handlePageChange(currentPage + 1)}
                  disabled={currentPage === totalPages}
                  className="button"
                >
                  {t('audit.next')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AuditLogTab;
