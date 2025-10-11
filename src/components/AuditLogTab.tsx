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
      return 'text-red-600';
    }
    if (action.includes('update') || action.includes('change') || action.includes('reset')) {
      return 'text-yellow-600';
    }
    if (action.includes('success') || action.includes('create')) {
      return 'text-green-600';
    }
    return 'text-gray-600';
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
      <div className="text-center py-8">
        <p className="text-red-600">You do not have permission to view audit logs.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">Audit Log</h2>
        <button
          onClick={handleExportCSV}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          disabled={logs.length === 0}
        >
          Export CSV
        </button>
      </div>

      {/* Statistics Summary */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-white p-4 rounded-lg shadow">
            <h3 className="text-sm font-medium text-gray-500">Total Events (30 days)</h3>
            <p className="text-2xl font-bold">{stats.totalEvents}</p>
          </div>
          <div className="bg-white p-4 rounded-lg shadow">
            <h3 className="text-sm font-medium text-gray-500">Top Action</h3>
            <p className="text-lg font-semibold">
              {stats.actionStats[0]?.action || 'N/A'} ({stats.actionStats[0]?.count || 0})
            </p>
          </div>
          <div className="bg-white p-4 rounded-lg shadow">
            <h3 className="text-sm font-medium text-gray-500">Most Active User</h3>
            <p className="text-lg font-semibold">
              {stats.userStats[0]?.username || 'N/A'} ({stats.userStats[0]?.count || 0})
            </p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white p-4 rounded-lg shadow space-y-4">
        <h3 className="font-semibold">Filters</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">User</label>
            <select
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              value={filters.userId}
              onChange={(e) => handleFilterChange('userId', e.target.value)}
            >
              <option value="">All Users</option>
              {users.map(user => (
                <option key={user.id} value={user.id}>{user.username}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Action</label>
            <select
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              value={filters.action}
              onChange={(e) => handleFilterChange('action', e.target.value)}
            >
              <option value="">All Actions</option>
              {uniqueActions.map(action => (
                <option key={action} value={action}>{action}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Resource</label>
            <select
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              value={filters.resource}
              onChange={(e) => handleFilterChange('resource', e.target.value)}
            >
              <option value="">All Resources</option>
              {uniqueResources.map(resource => (
                <option key={resource} value={resource}>{resource}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
            <input
              type="date"
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              value={filters.startDate}
              onChange={(e) => handleFilterChange('startDate', e.target.value)}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
            <input
              type="date"
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              value={filters.endDate}
              onChange={(e) => handleFilterChange('endDate', e.target.value)}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Search</label>
            <input
              type="text"
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              placeholder="Search in details..."
              value={filters.search}
              onChange={(e) => handleFilterChange('search', e.target.value)}
            />
          </div>
        </div>

        <div className="flex justify-between items-center">
          <button
            onClick={handleClearFilters}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
          >
            Clear Filters
          </button>
          <div>
            <label className="text-sm font-medium text-gray-700 mr-2">Per Page:</label>
            <select
              className="px-3 py-2 border border-gray-300 rounded-md"
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
        <div className="text-center py-8">Loading audit logs...</div>
      ) : error ? (
        <div className="text-center py-8 text-red-600">{error}</div>
      ) : logs.length === 0 ? (
        <div className="text-center py-8 text-gray-500">No audit log entries found</div>
      ) : (
        <>
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Timestamp
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      User
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Action
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Resource
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      IP Address
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Details
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {logs.map(log => (
                    <React.Fragment key={log.id}>
                      <tr className="hover:bg-gray-50 cursor-pointer" onClick={() => toggleExpand(log.id)}>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {formatTimestamp(log.timestamp)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {log.username || <span className="text-gray-400">System</span>}
                        </td>
                        <td className={`px-6 py-4 whitespace-nowrap text-sm font-medium ${getActionColor(log.action)}`}>
                          {log.action}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {log.resource || '-'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {log.ipAddress || '-'}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">
                          <div className="max-w-md truncate">
                            {log.details || '-'}
                          </div>
                        </td>
                      </tr>
                      {expandedLog === log.id && (
                        <tr>
                          <td colSpan={6} className="px-6 py-4 bg-gray-50">
                            <div className="space-y-2">
                              <div>
                                <strong className="text-sm">Details:</strong>
                                <pre className="mt-1 p-2 bg-white rounded border text-xs overflow-x-auto">
                                  {log.details ? JSON.stringify(JSON.parse(log.details), null, 2) : 'N/A'}
                                </pre>
                              </div>
                              {(log.valueBefore || log.valueAfter) && (
                                <div className="grid grid-cols-2 gap-4">
                                  {log.valueBefore && (
                                    <div>
                                      <strong className="text-sm">Before:</strong>
                                      <pre className="mt-1 p-2 bg-red-50 rounded border border-red-200 text-xs overflow-x-auto">
                                        {JSON.stringify(JSON.parse(log.valueBefore), null, 2)}
                                      </pre>
                                    </div>
                                  )}
                                  {log.valueAfter && (
                                    <div>
                                      <strong className="text-sm">After:</strong>
                                      <pre className="mt-1 p-2 bg-green-50 rounded border border-green-200 text-xs overflow-x-auto">
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
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-between items-center">
              <div className="text-sm text-gray-700">
                Showing {filters.offset + 1} to {Math.min(filters.offset + itemsPerPage, total)} of {total} entries
              </div>
              <div className="flex space-x-2">
                <button
                  onClick={() => handlePageChange(currentPage - 1)}
                  disabled={currentPage === 1}
                  className="px-4 py-2 border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  Previous
                </button>
                <span className="px-4 py-2">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  onClick={() => handlePageChange(currentPage + 1)}
                  disabled={currentPage === totalPages}
                  className="px-4 py-2 border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
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
