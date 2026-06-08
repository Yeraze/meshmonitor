/**
 * Tests for custom theme assignment actions.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustomThemeManagement } from './CustomThemeManagement';

const setDarkTheme = vi.fn();
const setLightTheme = vi.fn();
const setAppearanceMode = vi.fn();
const loadCustomThemes = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    customThemes: [
      {
        id: 1,
        name: 'Storm',
        slug: 'custom-storm',
        definition: JSON.stringify({
          base: '#111111',
          text: '#eeeeee',
          blue: '#89b4fa',
          green: '#a6e3a1',
          yellow: '#f9e2af',
          red: '#f38ba8',
        }),
        is_builtin: 0,
        created_at: 1,
        updated_at: 1,
      },
    ],
    loadCustomThemes,
    theme: 'mocha',
    appearanceMode: 'system',
    darkTheme: 'mocha',
    lightTheme: 'latte',
    setDarkTheme,
    setLightTheme,
    setAppearanceMode,
  }),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    authStatus: {
      permissions: {
        global: {
          themes: {
            write: true,
          },
        },
      },
    },
  }),
}));

vi.mock('../contexts/CsrfContext', () => ({
  useCsrf: () => ({
    getToken: () => 'csrf-token',
  }),
}));

vi.mock('../services/api', () => ({
  default: {
    getBaseUrl: vi.fn().mockResolvedValue(''),
  },
}));

vi.mock('./ThemeEditor', () => ({
  ThemeEditor: () => <div data-testid="theme-editor" />,
}));

describe('CustomThemeManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies a custom theme as the dark theme without changing light theme or mode', async () => {
    const user = userEvent.setup();
    render(<CustomThemeManagement />);

    await user.click(screen.getByRole('button', { name: 'theme_management.apply_dark' }));

    expect(setDarkTheme).toHaveBeenCalledWith('custom-storm');
    expect(setLightTheme).not.toHaveBeenCalled();
    expect(setAppearanceMode).not.toHaveBeenCalled();
  });

  it('applies a custom theme as the light theme without changing dark theme or mode', async () => {
    const user = userEvent.setup();
    render(<CustomThemeManagement />);

    await user.click(screen.getByRole('button', { name: 'theme_management.apply_light' }));

    expect(setLightTheme).toHaveBeenCalledWith('custom-storm');
    expect(setDarkTheme).not.toHaveBeenCalled();
    expect(setAppearanceMode).not.toHaveBeenCalled();
  });
});
