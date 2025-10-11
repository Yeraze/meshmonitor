/**
 * Audit Log Tab Component
 *
 * Admin-only interface for viewing and filtering audit logs
 */

import React, { useState, useEffect } from 'react';
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
      setError('Failed to load audit logs');
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
        ...logs.map(log =>
          [
            new Date(log.timestamp).toISOString(),
            log.username || 'System',
            log.action,
            log.resource || '',
            (log.details || '').replace(/,/g, ';'), // Escape commas
            log.ipAddress || ''
          ].join(',')
        )
      ].join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `audit-log-${new Date().toISOString()}.csv`;
      link.click();
      URL.revokeObjectURL(url);

      showToast('Audit log exported successfully', 'success');
    } catch (err) {
      logger.error('Failed to export CSV:', err);
      showToast('Failed to export audit log', 'error');
    }
  };

  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp);
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
          You do not have permission to view audit logs.
        </div>
      </div>
    );
  }

  return (
    <div className="audit-log-tab">
      <div className="audit-log-header">
        <h2>Audit Log</h2>
        <button
          onClick={handleExportCSV}
          className="button button-primary"
          disabled={logs.length === 0}
        >
          Export CSV
        </button>
      </div>

      {/* Statistics Summary */}
      {stats && (
        <div className="audit-stats">
          <div className="stat-card">
            <h3>Total Events (30 days)</h3>
            <p className="stat-value">{stats.totalEvents}</p>
          </div>
          <div className="stat-card">
            <h3>Top Action</h3>
            <p className="stat-label">
              {stats.actionStats[0]?.action || 'N/A'} ({stats.actionStats[0]?.count || 0})
            </p>
          </div>
          <div className="stat-card">
            <h3>Most Active User</h3>
            <p className="stat-label">
              {stats.userStats[0]?.username || 'N/A'} ({stats.userStats[0]?.count || 0})
            </p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="audit-filters">
        <h3>Filters</h3>
        <div className="filter-grid">
          <div className="form-group">
            <label>User</label>
            <select
              value={filters.userId}
              onChange={(e) => handleFilterChange('userId', e.target.value)}
            >
              <option value="">All Users</option>
              {users.map(user => (
                <option key={user.id} value={user.id}>{user.username}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Action</label>
            <select
              value={filters.action}
              onChange={(e) => handleFilterChange('action', e.target.value)}
            >
              <option value="">All Actions</option>
              {uniqueActions.map(action => (
                <option key={action} value={action}>{action}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Resource</label>
            <select
              value={filters.resource}
              onChange={(e) => handleFilterChange('resource', e.target.value)}
            >
              <option value="">All Resources</option>
              {uniqueResources.map(resource => (
                <option key={resource} value={resource}>{resource}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Start Date</label>
            <input
              type="date"
              value={filters.startDate}
              onChange={(e) => handleFilterChange('startDate', e.target.value)}
            />
          </div>

          <div className="form-group">
            <label>End Date</label>
            <input
              type="date"
              value={filters.endDate}
              onChange={(e) => handleFilterChange('endDate', e.target.value)}
            />
          </div>

          <div className="form-group">
            <label>Search</label>
            <input
              type="text"
              placeholder="Search in details..."
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
            Clear Filters
          </button>
          <div className="form-group inline-group">
            <label>Per Page:</label>
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
        <div className="audit-loading">Loading audit logs...</div>
      ) : error ? (
        <div className="error-message">{error}</div>
      ) : logs.length === 0 ? (
        <div className="audit-empty">No audit log entries found</div>
      ) : (
        <>
          <div className="audit-table-container">
            <table className="audit-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>IP Address</th>
                  <th>Details</th>
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
                        {log.username || <span className="system-label">System</span>}
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
                              <strong>Details:</strong>
                              <pre className="detail-pre">
                                {log.details ? JSON.stringify(JSON.parse(log.details), null, 2) : 'N/A'}
                              </pre>
                            </div>
                            {(log.valueBefore || log.valueAfter) && (
                              <div className="detail-comparison">
                                {log.valueBefore && (
                                  <div className="detail-section before">
                                    <strong>Before:</strong>
                                    <pre className="detail-pre">
                                      {JSON.stringify(JSON.parse(log.valueBefore), null, 2)}
                                    </pre>
                                  </div>
                                )}
                                {log.valueAfter && (
                                  <div className="detail-section after">
                                    <strong>After:</strong>
                                    <pre className="detail-pre">
                                      {JSON.stringify(JSON.parse(log.valueAfter), null, 2)}
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
                Showing {filters.offset + 1} to {Math.min(filters.offset + itemsPerPage, total)} of {total} entries
              </div>
              <div className="pagination-controls">
                <button
                  onClick={() => handlePageChange(currentPage - 1)}
                  disabled={currentPage === 1}
                  className="button"
                >
                  Previous
                </button>
                <span className="page-indicator">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  onClick={() => handlePageChange(currentPage + 1)}
                  disabled={currentPage === totalPages}
                  className="button"
                >
                  Next
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
