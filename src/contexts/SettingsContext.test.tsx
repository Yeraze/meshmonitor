/**
 * Tests for SettingsContext
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import type { TimeFormat, DateFormat, DistanceUnit } from './SettingsContext';
import type { SortField, SortDirection } from '../types/ui';

// Mock CsrfContext
vi.mock('./CsrfContext', () => ({
  useCsrf: () => ({
    token: 'test-csrf-token',
    getToken: () => 'test-csrf-token',
    fetchToken: vi.fn().mockResolvedValue('test-csrf-token'),
  }),
}));

// Mock api service
vi.mock('../services/api', () => ({
  default: {
    getBaseUrl: vi.fn().mockResolvedValue(''),
    getConfig: vi.fn().mockResolvedValue({}),
  },
}));

// Mock logger
vi.mock('../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

// Mock i18n
vi.mock('../config/i18n', () => ({
  default: {
    changeLanguage: vi.fn().mockResolvedValue(undefined),
    language: 'en',
  },
}));

// Mock tilesets
vi.mock('../config/tilesets', () => ({
  DEFAULT_TILESET_ID: 'osm',
  type: 'TilesetId',
}));

// Mock overlayColors
vi.mock('../config/overlayColors', () => ({
  getSchemeForTileset: vi.fn().mockReturnValue('default'),
  getOverlayColors: vi.fn().mockReturnValue({
    primary: '#ff0000',
    secondary: '#00ff00',
  }),
}));

// Mock EmojiPickerModal
vi.mock('../components/EmojiPickerModal/EmojiPickerModal', () => ({
  DEFAULT_TAPBACK_EMOJIS: ['👍', '❤️', '😂'],
}));

// Mock themeValidation
vi.mock('../utils/themeValidation', () => ({
  OPTIONAL_THEME_COLORS: [],
}));

// Mock temperature util
vi.mock('../utils/temperature', () => ({
  type: 'TemperatureUnit',
}));

// Setup global fetch mock
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Default successful settings response
const defaultSettingsResponse = {
  maxNodeAgeHours: '48',
  inactiveNodeThresholdHours: '12',
  temperatureUnit: 'F',
  distanceUnit: 'mi',
  timeFormat: '12',
  dateFormat: 'DD/MM/YYYY',
  preferredSortField: 'battery',
  preferredSortDirection: 'desc',
  theme: 'dracula',
  language: 'en',
};

const createFetchMock = (settings = defaultSettingsResponse, ok = true) => {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/settings')) {
      return Promise.resolve({
        ok,
        json: async () => settings,
        status: ok ? 200 : 500,
        statusText: ok ? 'OK' : 'Internal Server Error',
      });
    }
    if (url.includes('/api/user/map-preferences')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ preferences: null }),
      });
    }
    if (url.includes('/api/themes')) {
      return Promise.resolve({
        ok: true,
        json: async () => [],
      });
    }
    if (url.includes('/api/push/preferences')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          mutedChannels: [],
          mutedDMs: [],
        }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
};

describe('SettingsContext Types', () => {
  describe('TimeFormat', () => {
    it('should support 12-hour format', () => {
      const format: TimeFormat = '12';
      expect(format).toBe('12');
    });

    it('should support 24-hour format', () => {
      const format: TimeFormat = '24';
      expect(format).toBe('24');
    });
  });

  describe('DateFormat', () => {
    it('should support MM/DD/YYYY format', () => {
      const format: DateFormat = 'MM/DD/YYYY';
      expect(format).toBe('MM/DD/YYYY');
    });

    it('should support DD/MM/YYYY format', () => {
      const format: DateFormat = 'DD/MM/YYYY';
      expect(format).toBe('DD/MM/YYYY');
    });

    it('should support YYYY-MM-DD format', () => {
      const format: DateFormat = 'YYYY-MM-DD';
      expect(format).toBe('YYYY-MM-DD');
    });
  });

  describe('DistanceUnit', () => {
    it('should support kilometers', () => {
      const unit: DistanceUnit = 'km';
      expect(unit).toBe('km');
    });

    it('should support miles', () => {
      const unit: DistanceUnit = 'mi';
      expect(unit).toBe('mi');
    });
  });

  describe('Sort settings', () => {
    it('should support all valid sort fields', () => {
      const fields: SortField[] = [
        'longName',
        'shortName',
        'id',
        'lastHeard',
        'snr',
        'battery',
        'hwModel',
        'hops'
      ];

      fields.forEach(field => {
        expect(field).toBeDefined();
      });
    });

    it('should support sort directions', () => {
      const asc: SortDirection = 'asc';
      const desc: SortDirection = 'desc';

      expect(asc).toBe('asc');
      expect(desc).toBe('desc');
    });
  });

  describe('Settings configuration', () => {
    it('should support complete display preferences configuration', () => {
      interface DisplayPreferences {
        preferredSortField: SortField;
        preferredSortDirection: SortDirection;
        timeFormat: TimeFormat;
        dateFormat: DateFormat;
        distanceUnit: DistanceUnit;
      }

      const config: DisplayPreferences = {
        preferredSortField: 'battery',
        preferredSortDirection: 'desc',
        timeFormat: '12',
        dateFormat: 'DD/MM/YYYY',
        distanceUnit: 'mi'
      };

      expect(config.preferredSortField).toBe('battery');
      expect(config.preferredSortDirection).toBe('desc');
      expect(config.timeFormat).toBe('12');
      expect(config.dateFormat).toBe('DD/MM/YYYY');
      expect(config.distanceUnit).toBe('mi');
    });

    it('should support default values', () => {
      interface DefaultSettings {
        preferredSortField: SortField;
        preferredSortDirection: SortDirection;
        timeFormat: TimeFormat;
        dateFormat: DateFormat;
      }

      const defaults: DefaultSettings = {
        preferredSortField: 'longName',
        preferredSortDirection: 'asc',
        timeFormat: '24',
        dateFormat: 'MM/DD/YYYY'
      };

      expect(defaults.preferredSortField).toBe('longName');
      expect(defaults.preferredSortDirection).toBe('asc');
      expect(defaults.timeFormat).toBe('24');
      expect(defaults.dateFormat).toBe('MM/DD/YYYY');
    });
  });

  describe('localStorage key naming', () => {
    it('should use consistent localStorage key names', () => {
      const keys = {
        sortField: 'preferredSortField',
        sortDirection: 'preferredSortDirection',
        timeFormat: 'timeFormat',
        dateFormat: 'dateFormat',
        distanceUnit: 'distanceUnit'
      };

      expect(keys.sortField).toBe('preferredSortField');
      expect(keys.sortDirection).toBe('preferredSortDirection');
      expect(keys.timeFormat).toBe('timeFormat');
      expect(keys.dateFormat).toBe('dateFormat');
      expect(keys.distanceUnit).toBe('distanceUnit');
    });
  });
});

describe('SettingsProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockReset();
    createFetchMock();
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('should render children without crashing', async () => {
    const { SettingsProvider } = await import('./SettingsContext');

    await act(async () => {
      render(
        <SettingsProvider>
          <div data-testid="child">Hello</div>
        </SettingsProvider>
      );
    });

    expect(screen.getByTestId('child')).toBeDefined();
  });

  it('should provide context with default values via useSettings hook', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    // Verify context was provided
    expect(contextValue).toBeDefined();
    expect(contextValue.setMaxNodeAgeHours).toBeDefined();
    expect(contextValue.setDistanceUnit).toBeDefined();
    expect(contextValue.setTimeFormat).toBeDefined();
  });

  it('should initialize timeFormat from localStorage', async () => {
    localStorage.setItem('timeFormat', '12');
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    // The initial state should come from localStorage
    expect(contextValue.timeFormat).toBe('12');
  });

  it('should initialize distanceUnit from localStorage', async () => {
    localStorage.setItem('distanceUnit', 'mi');
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    expect(contextValue.distanceUnit).toBe('mi');
  });

  it('should default distanceUnit to km when not in localStorage', async () => {
    localStorage.removeItem('distanceUnit');
    // Mock server to not override distanceUnit
    mockFetch.mockReset();
    createFetchMock({});
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    expect(contextValue.distanceUnit).toBe('km');
  });

  it('should initialize preferredSortField from localStorage', async () => {
    localStorage.setItem('preferredSortField', 'battery');
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    expect(contextValue.preferredSortField).toBe('battery');
  });

  it('should default preferredSortDirection to asc', async () => {
    localStorage.removeItem('preferredSortDirection');
    // Mock server to not override preferredSortDirection
    mockFetch.mockReset();
    createFetchMock({});
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    expect(contextValue.preferredSortDirection).toBe('asc');
  });

  it('should update localStorage when setMaxNodeAgeHours is called', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    await act(async () => {
      contextValue.setMaxNodeAgeHours(48);
    });

    expect(localStorage.getItem('maxNodeAgeHours')).toBe('48');
  });

  it('should update localStorage when setDistanceUnit is called', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    await act(async () => {
      contextValue.setDistanceUnit('mi');
    });

    expect(localStorage.getItem('distanceUnit')).toBe('mi');
    expect(contextValue.distanceUnit).toBe('mi');
  });

  it('should update localStorage when setTimeFormat is called', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    await act(async () => {
      contextValue.setTimeFormat('12');
    });

    expect(localStorage.getItem('timeFormat')).toBe('12');
    expect(contextValue.timeFormat).toBe('12');
  });

  it('should update localStorage when setDateFormat is called', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    await act(async () => {
      contextValue.setDateFormat('YYYY-MM-DD');
    });

    expect(localStorage.getItem('dateFormat')).toBe('YYYY-MM-DD');
    expect(contextValue.dateFormat).toBe('YYYY-MM-DD');
  });

  it('should set isLoading to false after settings are loaded', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(contextValue.isLoading).toBe(false);
    });
  });

  it('should handle failed settings fetch gracefully', async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/settings')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    // Should not throw
    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(contextValue.isLoading).toBe(false);
    });

    // Should fall back to defaults
    expect(contextValue.distanceUnit).toBeDefined();
    expect(contextValue.timeFormat).toBeDefined();
  });

  it('should handle fetch error (network failure) gracefully', async () => {
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new Error('Network error'));

    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    // Should not throw
    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(contextValue.isLoading).toBe(false);
    });

    // Should still be functional with defaults
    expect(contextValue.setMaxNodeAgeHours).toBeDefined();
  });

  it('should provide mutedChannels as empty array by default', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(contextValue.isLoading).toBe(false);
    });

    expect(Array.isArray(contextValue.mutedChannels)).toBe(true);
  });

  it('should provide mutedDMs as empty array by default', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(contextValue.isLoading).toBe(false);
    });

    expect(Array.isArray(contextValue.mutedDMs)).toBe(true);
  });

  it('should provide isChannelMuted function', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(contextValue.isLoading).toBe(false);
    });

    expect(typeof contextValue.isChannelMuted).toBe('function');
    expect(contextValue.isChannelMuted(1)).toBe(false);
  });

  it('should provide isDMMuted function', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(contextValue.isLoading).toBe(false);
    });

    expect(typeof contextValue.isDMMuted).toBe('function');
    expect(contextValue.isDMMuted('some-uuid')).toBe(false);
  });

  it('should initialize enableAudioNotifications to true by default', async () => {
    localStorage.removeItem('enableAudioNotifications');
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    // Default should be true
    expect(contextValue.enableAudioNotifications).toBe(true);
  });

  it('should initialize nodeDimmingEnabled to false by default', async () => {
    localStorage.removeItem('nodeDimmingEnabled');
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    expect(contextValue.nodeDimmingEnabled).toBe(false);
  });

  it('should update preferredSortField via setter', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    await act(async () => {
      contextValue.setPreferredSortField('snr');
    });

    expect(contextValue.preferredSortField).toBe('snr');
    expect(localStorage.getItem('preferredSortField')).toBe('snr');
  });

  it('should update preferredSortDirection via setter', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    await act(async () => {
      contextValue.setPreferredSortDirection('desc');
    });

    expect(contextValue.preferredSortDirection).toBe('desc');
    expect(localStorage.getItem('preferredSortDirection')).toBe('desc');
  });

  it('should update theme via setter', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    await act(async () => {
      contextValue.setTheme('nord');
    });

    expect(contextValue.theme).toBe('nord');
    expect(localStorage.getItem('theme')).toBe('nord');
  });

  it('should set temporaryTileset via setter', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    await act(async () => {
      contextValue.setTemporaryTileset('satellite');
    });

    expect(contextValue.temporaryTileset).toBe('satellite');
  });

  it('should initialize nodeHopsCalculation to nodeinfo by default', async () => {
    localStorage.removeItem('nodeHopsCalculation');
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    expect(contextValue.nodeHopsCalculation).toBe('nodeinfo');
  });

  it('should initialize from localStorage nodeHopsCalculation', async () => {
    localStorage.setItem('nodeHopsCalculation', 'traceroute');
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    expect(contextValue.nodeHopsCalculation).toBe('traceroute');
  });

  it('should provide overlayScheme derived from mapTileset', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    expect(contextValue.overlayScheme).toBeDefined();
    expect(contextValue.overlayColors).toBeDefined();
  });

  it('should provide customThemes as array', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    expect(Array.isArray(contextValue.customThemes)).toBe(true);
  });

  it('should provide customTilesets as array', async () => {
    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    expect(Array.isArray(contextValue.customTilesets)).toBe(true);
  });

  it('should update tapbackEmojis via setter', async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({}),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const { SettingsProvider, useSettings } = await import('./SettingsContext');

    let contextValue: any;

    const Consumer = () => {
      contextValue = useSettings();
      return <div data-testid="consumer">loaded</div>;
    };

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('consumer')).toBeDefined();
    });

    const newEmojis = [{ emoji: '🚀', label: 'rocket' }, { emoji: '💯', label: '100' }];

    await act(async () => {
      await contextValue.setTapbackEmojis(newEmojis);
    });

    expect(contextValue.tapbackEmojis).toEqual(newEmojis);
  });
});

describe('useSettings hook', () => {
  it('should throw if used outside SettingsProvider', async () => {
    const { useSettings } = await import('./SettingsContext');

    const ThrowingComponent = () => {
      useSettings();
      return null;
    };

    // Suppress console error from React
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      render(<ThrowingComponent />);
    }).toThrow();

    consoleSpy.mockRestore();
  });
});
