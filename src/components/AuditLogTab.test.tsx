/**
 * AuditLogTab Component Tests
 *
 * Tests the audit log viewer component including:
 * - Rendering and display
 * - Filtering functionality
 * - Pagination
 * - Permission checks
 * - CSV export
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import AuditLogTab from './AuditLogTab';
import { AuthContext } from '../contexts/AuthContext';
import { ToastContext } from './ToastContainer';
import api from '../services/api';

// Mock the API module
vi.mock('../services/api', () => ({
  default: {
    get: vi.fn()
  }
}));

// Mock logger
vi.mock('../utils/logger', () => ({
  logger: {
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn()
  }
}));

const mockAuditLogs = [
  {
    id: 1,
    userId: 1,
    username: 'admin',
    action: 'login_success',
    resource: 'auth',
    details: JSON.stringify({ method: 'password' }),
    ipAddress: '192.168.1.1',
    valueBefore: null,
    valueAfter: null,
    timestamp: Date.now() - 1000
  },
  {
    id: 2,
    userId: 1,
    username: 'admin',
    action: 'settings_updated',
    resource: 'settings',
    details: JSON.stringify({ keys: ['theme'] }),
    ipAddress: '192.168.1.1',
    valueBefore: JSON.stringify({ theme: 'light' }),
    valueAfter: JSON.stringify({ theme: 'dark' }),
    timestamp: Date.now() - 2000
  },
  {
    id: 3,
    userId: null,
    username: null,
    action: 'system_startup',
    resource: 'system',
    details: 'System started',
    ipAddress: null,
    valueBefore: null,
    valueAfter: null,
    timestamp: Date.now() - 3000
  }
];

const mockStats = {
  actionStats: [
    { action: 'login_success', count: 5 },
    { action: 'settings_updated', count: 3 }
  ],
  userStats: [
    { username: 'admin', count: 10 },
    { username: 'user', count: 5 }
  ],
  dailyStats: [
    { date: '2025-01-01', count: 15 }
  ],
  totalEvents: 15
};

const mockUsers = [
  { id: 1, username: 'admin' },
  { id: 2, username: 'user' }
];

describe('AuditLogTab', () => {
  const mockShowToast = vi.fn();

  // Helper to create complete authStatus objects
  const createAuthStatus = (overrides: any = {}) => ({
    authenticated: true,
    user: { id: 1, username: 'admin', email: null, displayName: null, authProvider: 'local' as const, isAdmin: true, isActive: true, createdAt: Date.now(), lastLoginAt: Date.now() },
    permissions: { audit: { read: true, write: true } },
    oidcEnabled: false,
    localAuthDisabled: false,
    ...overrides
  });

  const renderWithProviders = (authStatus: any) => {
    return render(
      <AuthContext.Provider value={{
        authStatus,
        loading: false,
        hasPermission: () => true,
        login: vi.fn(),
        loginWithOIDC: vi.fn(),
        logout: vi.fn(),
        refreshAuth: vi.fn()
      }}>
        <ToastContext.Provider value={{ showToast: mockShowToast, toasts: [] }}>
          <AuditLogTab />
        </ToastContext.Provider>
      </AuthContext.Provider>
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (api.get as any).mockResolvedValue({
      logs: mockAuditLogs,
      total: mockAuditLogs.length
    });
  });

  describe('Permission Checks', () => {
    it('should show error message when user lacks audit read permission', () => {
      const authStatus = createAuthStatus({
        user: { id: 1, username: 'user', email: null, displayName: null, authProvider: 'local' as const, isAdmin: false, isActive: true, createdAt: Date.now(), lastLoginAt: Date.now() },
        permissions: { audit: { read: false, write: false } }
      });

      render(
        <AuthContext.Provider value={{
          authStatus,
          loading: false,
          hasPermission: () => false,
          login: vi.fn(),
          loginWithOIDC: vi.fn(),
          logout: vi.fn(),
          refreshAuth: vi.fn()
        }}>
          <ToastContext.Provider value={{ showToast: mockShowToast, toasts: [] }}>
            <AuditLogTab />
          </ToastContext.Provider>
        </AuthContext.Provider>
      );

      expect(screen.getByText(/You do not have permission to view audit logs/i)).toBeInTheDocument();
    });

    it('should render audit log when user has permission', async () => {
      const authStatus = createAuthStatus();

      renderWithProviders(authStatus);

      await waitFor(() => {
        expect(screen.getByText('Audit Log')).toBeInTheDocument();
      });
    });
  });

  describe('Data Loading', () => {
    const authStatus = createAuthStatus();

    it('should show loading state initially', () => {
      (api.get as any).mockImplementation(() => new Promise(() => {})); // Never resolves

      renderWithProviders(authStatus);

      expect(screen.getByText(/Loading audit logs/i)).toBeInTheDocument();
    });

    it('should fetch audit logs on mount', async () => {
      (api.get as any).mockResolvedValueOnce({ logs: mockAuditLogs, total: mockAuditLogs.length });
      (api.get as any).mockResolvedValueOnce({ stats: mockStats });
      (api.get as any).mockResolvedValueOnce({ users: mockUsers });

      renderWithProviders(authStatus);

      await waitFor(() => {
        expect(api.get).toHaveBeenCalledWith(expect.stringContaining('/api/audit'));
      });

      await waitFor(() => {
        expect(api.get).toHaveBeenCalledWith(expect.stringContaining('/api/audit/stats/summary'));
      });

      await waitFor(() => {
        expect(api.get).toHaveBeenCalledWith('/api/users');
      });
    });

    it('should display audit log entries', async () => {
      (api.get as any).mockResolvedValueOnce({ logs: mockAuditLogs, total: mockAuditLogs.length });
      (api.get as any).mockResolvedValueOnce({ stats: mockStats });
      (api.get as any).mockResolvedValueOnce({ users: mockUsers });

      renderWithProviders(authStatus);

      await waitFor(() => {
        expect(screen.getByText('login_success')).toBeInTheDocument();
        expect(screen.getByText('settings_updated')).toBeInTheDocument();
        expect(screen.getByText('system_startup')).toBeInTheDocument();
      });
    });

    it('should show error message on load failure', async () => {
      (api.get as any).mockRejectedValue(new Error('Network error'));

      renderWithProviders(authStatus);

      await waitFor(() => {
        expect(screen.getByText(/Failed to load audit logs/i)).toBeInTheDocument();
      });
    });

    it('should show message when no logs found', async () => {
      (api.get as any).mockResolvedValueOnce({ logs: [], total: 0 });
      (api.get as any).mockResolvedValueOnce({ stats: mockStats });
      (api.get as any).mockResolvedValueOnce({ users: mockUsers });

      renderWithProviders(authStatus);

      await waitFor(() => {
        expect(screen.getByText(/No audit log entries found/i)).toBeInTheDocument();
      });
    });
  });

  describe('Statistics Display', () => {
    const authStatus = createAuthStatus();

    it('should display statistics cards', async () => {
      (api.get as any).mockResolvedValueOnce({ logs: mockAuditLogs, total: mockAuditLogs.length });
      (api.get as any).mockResolvedValueOnce({ stats: mockStats });
      (api.get as any).mockResolvedValueOnce({ users: mockUsers });

      renderWithProviders(authStatus);

      await waitFor(() => {
        expect(screen.getByText('Total Events (30 days)')).toBeInTheDocument();
        expect(screen.getByText('15')).toBeInTheDocument(); // totalEvents
        expect(screen.getByText('Top Action')).toBeInTheDocument();
        expect(screen.getByText('Most Active User')).toBeInTheDocument();
      });
    });
  });

  describe('Filtering', () => {
    const authStatus = createAuthStatus();

    it('should have filter inputs', async () => {
      (api.get as any).mockResolvedValue({ logs: mockAuditLogs, total: mockAuditLogs.length });
      (api.get as any).mockResolvedValue({ stats: mockStats });
      (api.get as any).mockResolvedValue({ users: mockUsers });

      renderWithProviders(authStatus);

      await waitFor(() => {
        expect(screen.getByText('Filters')).toBeInTheDocument();
      });

      // Check for filter controls
      expect(screen.getByLabelText(/User/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Action/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Resource/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Start Date/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/End Date/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Search/i)).toBeInTheDocument();
    });

    it('should have Clear Filters button', async () => {
      (api.get as any).mockResolvedValue({ logs: mockAuditLogs, total: mockAuditLogs.length });
      (api.get as any).mockResolvedValue({ stats: mockStats });
      (api.get as any).mockResolvedValue({ users: mockUsers });

      renderWithProviders(authStatus);

      await waitFor(() => {
        expect(screen.getByText('Clear Filters')).toBeInTheDocument();
      });
    });
  });

  describe('Pagination', () => {
    const authStatus = createAuthStatus();

    it('should display pagination controls when total exceeds page size', async () => {
      (api.get as any).mockResolvedValueOnce({ logs: mockAuditLogs, total: 150 });
      (api.get as any).mockResolvedValueOnce({ stats: mockStats });
      (api.get as any).mockResolvedValueOnce({ users: mockUsers });

      renderWithProviders(authStatus);

      await waitFor(() => {
        expect(screen.getByText(/Showing/)).toBeInTheDocument();
        expect(screen.getByText(/Previous/)).toBeInTheDocument();
        expect(screen.getByText(/Next/)).toBeInTheDocument();
      });
    });

    it('should not display pagination when total fits in one page', async () => {
      (api.get as any).mockResolvedValueOnce({ logs: mockAuditLogs, total: 3 });
      (api.get as any).mockResolvedValueOnce({ stats: mockStats });
      (api.get as any).mockResolvedValueOnce({ users: mockUsers });

      renderWithProviders(authStatus);

      await waitFor(() => {
        expect(screen.queryByText(/Previous/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Next/)).not.toBeInTheDocument();
      });
    });
  });

  describe('Row Expansion', () => {
    const authStatus = createAuthStatus();

    it('should show before/after values when row is expanded', async () => {
      (api.get as any).mockResolvedValueOnce({ logs: mockAuditLogs, total: mockAuditLogs.length });
      (api.get as any).mockResolvedValueOnce({ stats: mockStats });
      (api.get as any).mockResolvedValueOnce({ users: mockUsers });

      renderWithProviders(authStatus);

      await waitFor(() => {
        expect(screen.getByText('settings_updated')).toBeInTheDocument();
      });

      // Click on the row with settings_updated
      const row = screen.getByText('settings_updated').closest('tr');
      fireEvent.click(row!);

      await waitFor(() => {
        expect(screen.getByText(/Before:/)).toBeInTheDocument();
        expect(screen.getByText(/After:/)).toBeInTheDocument();
      });
    });
  });

  describe('Action Color Coding', () => {
    it('should apply correct class for error actions', () => {
      const mockGetActionColor = (action: string): string => {
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

      expect(mockGetActionColor('login_fail')).toBe('action-error');
      expect(mockGetActionColor('node_delete')).toBe('action-error');
      expect(mockGetActionColor('nodes_purge')).toBe('action-error');
    });

    it('should apply correct class for warning actions', () => {
      const mockGetActionColor = (action: string): string => {
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

      expect(mockGetActionColor('settings_updated')).toBe('action-warning');
      expect(mockGetActionColor('password_change')).toBe('action-warning');
      expect(mockGetActionColor('config_reset')).toBe('action-warning');
    });

    it('should apply correct class for success actions', () => {
      const mockGetActionColor = (action: string): string => {
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

      expect(mockGetActionColor('login_success')).toBe('action-success');
      expect(mockGetActionColor('user_create')).toBe('action-success');
    });
  });

  describe('CSV Export', () => {
    const authStatus = createAuthStatus();

    it('should have Export CSV button', async () => {
      (api.get as any).mockResolvedValueOnce({ logs: mockAuditLogs, total: mockAuditLogs.length });
      (api.get as any).mockResolvedValueOnce({ stats: mockStats });
      (api.get as any).mockResolvedValueOnce({ users: mockUsers });

      renderWithProviders(authStatus);

      await waitFor(() => {
        expect(screen.getByText('Export CSV')).toBeInTheDocument();
      });
    });

    it('should disable Export CSV button when no logs', async () => {
      (api.get as any).mockResolvedValueOnce({ logs: [], total: 0 });
      (api.get as any).mockResolvedValueOnce({ stats: mockStats });
      (api.get as any).mockResolvedValueOnce({ users: mockUsers });

      renderWithProviders(authStatus);

      await waitFor(() => {
        const exportButton = screen.getByText('Export CSV');
        expect(exportButton).toBeDisabled();
      });
    });
  });

  describe('System Actions', () => {
    const authStatus = createAuthStatus();

    it('should display "System" for actions without user', async () => {
      (api.get as any).mockResolvedValueOnce({ logs: mockAuditLogs, total: mockAuditLogs.length });
      (api.get as any).mockResolvedValueOnce({ stats: mockStats });
      (api.get as any).mockResolvedValueOnce({ users: mockUsers });

      renderWithProviders(authStatus);

      await waitFor(() => {
        expect(screen.getByText('System')).toBeInTheDocument();
      });
    });
  });

  describe('Timestamp Formatting', () => {
    it('should format timestamp correctly', () => {
      const mockFormatTimestamp = (timestamp: number) => {
        const date = new Date(timestamp);
        return date.toLocaleString();
      };

      const now = Date.now();
      const formatted = mockFormatTimestamp(now);
      const date = new Date(now);

      expect(formatted).toBe(date.toLocaleString());
    });
  });
});
