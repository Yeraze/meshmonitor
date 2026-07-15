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

let mockSystemIsDark = true;
let mediaQueryListeners: Array<(event: MediaQueryListEvent) => void> = [];

const installMatchMediaMock = () => {
  mediaQueryListeners = [];
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' ? mockSystemIsDark : false,
      media: query,
      onchange: null,
      addEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => {
        mediaQueryListeners.push(listener);
      },
      removeEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => {
        mediaQueryListeners = mediaQueryListeners.filter(item => item !== listener);
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
};

const setMockSystemAppearance = async (isDark: boolean) => {
  mockSystemIsDark = isDark;
  await act(async () => {
    mediaQueryListeners.forEach(listener => listener({ matches: isDark } as MediaQueryListEvent));
  });
};

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

const createFetchMock = (settings: Record<string, any> = defaultSettingsResponse, ok = true) => {
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

describe('per-theme map tileset helpers', () => {
  it('uses smart defaults only for the untouched legacy selection', async () => {
    const { resolveLegacyMapTilesets } = await import('./SettingsContext');
    expect(resolveLegacyMapTilesets(null)).toEqual({ light: 'osm', dark: 'cartoDark' });
    expect(resolveLegacyMapTilesets('osm')).toEqual({ light: 'osm', dark: 'cartoDark' });
    expect(resolveLegacyMapTilesets('openTopo')).toEqual({ light: 'openTopo', dark: 'openTopo' });
    expect(resolveLegacyMapTilesets('custom-7')).toEqual({ light: 'custom-7', dark: 'custom-7' });
  });

  it('resolves explicit and system appearance modes', async () => {
    const { getActiveAppearanceMode, getEffectiveTileset } = await import('./SettingsContext');
    expect(getEffectiveTileset('light', 'cartoDark', 'osm', true)).toBe('osm');
    expect(getEffectiveTileset('dark', 'cartoDark', 'osm', false)).toBe('cartoDark');
    expect(getEffectiveTileset('system', 'cartoDark', 'osm', true)).toBe('cartoDark');
    expect(getEffectiveTileset('system', 'cartoDark', 'osm', false)).toBe('osm');
    expect(getActiveAppearanceMode('dark', false)).toBe('dark');
    expect(getActiveAppearanceMode('light', true)).toBe('light');
    expect(getActiveAppearanceMode('system', true)).toBe('dark');
    expect(getActiveAppearanceMode('system', false)).toBe('light');
  });
});

describe('SettingsProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSystemIsDark = true;
    installMatchMediaMock();
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

  it('should default new users to system appearance with mocha dark and latte light themes', async () => {
    mockSystemIsDark = false;
    installMatchMediaMock();
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
      expect(contextValue.isLoading).toBe(false);
    });

    expect(contextValue.appearanceMode).toBe('system');
    expect(contextValue.darkTheme).toBe('mocha');
    expect(contextValue.lightTheme).toBe('latte');
    expect(contextValue.theme).toBe('latte');
    expect(document.documentElement.getAttribute('data-theme')).toBe('latte');
  });

  it('should migrate legacy mocha users to system appearance with mocha and latte', async () => {
    localStorage.setItem('theme', 'mocha');
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
      expect(contextValue.isLoading).toBe(false);
    });

    expect(contextValue.appearanceMode).toBe('system');
    expect(contextValue.darkTheme).toBe('mocha');
    expect(contextValue.lightTheme).toBe('latte');
    expect(contextValue.theme).toBe('mocha');
  });

  it('should migrate legacy non-mocha users to dark mode with both theme slots set to the legacy theme', async () => {
    localStorage.setItem('theme', 'dracula');
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
      expect(contextValue.isLoading).toBe(false);
    });

    expect(contextValue.appearanceMode).toBe('dark');
    expect(contextValue.darkTheme).toBe('dracula');
    expect(contextValue.lightTheme).toBe('dracula');
    expect(contextValue.theme).toBe('dracula');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dracula');
  });

  it('should switch effective theme when system appearance changes in system mode', async () => {
    mockSystemIsDark = false;
    installMatchMediaMock();
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
      expect(contextValue.theme).toBe('latte');
    });

    await setMockSystemAppearance(true);

    await waitFor(() => {
      expect(contextValue.theme).toBe('mocha');
      expect(document.documentElement.getAttribute('data-theme')).toBe('mocha');
    });
  });

  it('should ignore system appearance changes in manual dark and light modes', async () => {
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
      expect(contextValue.isLoading).toBe(false);
    });

    await act(async () => {
      contextValue.setAppearanceMode('dark');
    });
    await setMockSystemAppearance(false);

    await waitFor(() => {
      expect(contextValue.theme).toBe('mocha');
    });

    await act(async () => {
      contextValue.setAppearanceMode('light');
    });
    await setMockSystemAppearance(true);

    await waitFor(() => {
      expect(contextValue.theme).toBe('latte');
    });
  });

  it('should allow custom themes in dark and light theme slots', async () => {
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
      expect(contextValue.isLoading).toBe(false);
    });

    await act(async () => {
      contextValue.setDarkTheme('custom-night');
      contextValue.setLightTheme('custom-day');
    });

    await waitFor(() => {
      expect(contextValue.darkTheme).toBe('custom-night');
      expect(contextValue.lightTheme).toBe('custom-day');
    });
    expect(localStorage.getItem('darkTheme')).toBe('custom-night');
    expect(localStorage.getItem('lightTheme')).toBe('custom-day');
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

  it('should default mapCenterTargetZoom to 17 when not in localStorage (#4046 item 2)', async () => {
    localStorage.removeItem('mapCenterTargetZoom');
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

    expect(contextValue.mapCenterTargetZoom).toBe(17);
  });

  it('should initialize mapCenterTargetZoom from localStorage', async () => {
    localStorage.setItem('mapCenterTargetZoom', '14');
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

    expect(contextValue.mapCenterTargetZoom).toBe(14);
  });

  it('should update localStorage when setMapCenterTargetZoom is called', async () => {
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
      contextValue.setMapCenterTargetZoom(12);
    });

    expect(localStorage.getItem('mapCenterTargetZoom')).toBe('12');
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

  it('uses the new defaults for an untouched legacy OSM preference', async () => {
    localStorage.setItem('mapTileset', 'osm');
    mockFetch.mockReset();
    createFetchMock({ appearanceMode: 'system', mapTileset: 'osm' });
    const { SettingsProvider, useSettings } = await import('./SettingsContext');
    let contextValue: any;
    const Consumer = () => { contextValue = useSettings(); return <div />; };

    await act(async () => { render(<SettingsProvider><Consumer /></SettingsProvider>); });
    await waitFor(() => expect(contextValue.isLoading).toBe(false));

    expect(contextValue.mapTilesetLight).toBe('osm');
    expect(contextValue.mapTilesetDark).toBe('cartoDark');
    expect(contextValue.mapTileset).toBe('cartoDark');
    expect(contextValue.activeMapTilesetMode).toBe('dark');
  });

  it('preserves a customized legacy tileset in both slots', async () => {
    localStorage.setItem('mapTileset', 'custom-7');
    mockFetch.mockReset();
    createFetchMock({ appearanceMode: 'system', mapTileset: 'custom-7' });
    const { SettingsProvider, useSettings } = await import('./SettingsContext');
    let contextValue: any;
    const Consumer = () => { contextValue = useSettings(); return <div />; };

    await act(async () => { render(<SettingsProvider><Consumer /></SettingsProvider>); });
    await waitFor(() => expect(contextValue.isLoading).toBe(false));

    expect(contextValue.mapTilesetLight).toBe('custom-7');
    expect(contextValue.mapTilesetDark).toBe('custom-7');
  });

  it('switches the effective tileset when system appearance changes', async () => {
    mockSystemIsDark = false;
    installMatchMediaMock();
    mockFetch.mockReset();
    createFetchMock({ appearanceMode: 'system', mapTilesetLight: 'cartoLight', mapTilesetDark: 'cartoDark' });
    const { SettingsProvider, useSettings } = await import('./SettingsContext');
    let contextValue: any;
    const Consumer = () => { contextValue = useSettings(); return <div />; };

    await act(async () => { render(<SettingsProvider><Consumer /></SettingsProvider>); });
    await waitFor(() => expect(contextValue.mapTileset).toBe('cartoLight'));
    expect(contextValue.activeMapTilesetMode).toBe('light');
    await setMockSystemAppearance(true);
    expect(contextValue.mapTileset).toBe('cartoDark');
    expect(contextValue.activeMapTilesetMode).toBe('dark');
  });

  it('updates only the active slot and posts both preferences', async () => {
    mockFetch.mockReset();
    createFetchMock({ appearanceMode: 'dark', mapTilesetLight: 'osm', mapTilesetDark: 'cartoDark' });
    const { SettingsProvider, useSettings } = await import('./SettingsContext');
    let contextValue: any;
    const Consumer = () => { contextValue = useSettings(); return <div />; };

    await act(async () => { render(<SettingsProvider><Consumer /></SettingsProvider>); });
    await waitFor(() => expect(contextValue.isLoading).toBe(false));
    await act(async () => { contextValue.setMapTileset('custom-night'); });

    expect(contextValue.mapTilesetLight).toBe('osm');
    expect(contextValue.mapTilesetDark).toBe('custom-night');
    const post = mockFetch.mock.calls.find(([url, options]) =>
      String(url).includes('/api/user/map-preferences') && options?.method === 'POST');
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({
      mapTileset: 'custom-night',
      mapTilesetLight: 'osm',
      mapTilesetDark: 'custom-night',
    });
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
