/**
 * @vitest-environment jsdom
 *
 * #5649, settings family, end to end: a real section, the real `useSaveBar`
 * and the real `SaveBar`. A retention field can be cleared; while it is blank
 * or out of range the bar's Save button is off and no request is sent; once
 * fixed, Save posts the value in the type the server has always received.
 *
 * Before the fix the field ran `parseInt(e.target.value) || 30`, so clearing
 * it put 30 back and the user could not retype the first digit.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  // Key-only `t`, so the buttons are found by their locale key.
  return createReactI18nextMock((key: string) => key);
});

vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../services/api', () => {
  class MockApiError extends Error {}
  return { ApiError: MockApiError, default: { get: apiGet, post: apiPost } };
});

import DatabaseMaintenanceSection from './DatabaseMaintenanceSection';
import { SaveBarProvider } from '../../contexts/SaveBarContext';
import { SaveBar } from '../SaveBar/SaveBar';

const STATUS = {
  enabled: true,
  maintenanceTime: '04:00',
  maintenanceInProgress: false,
  lastRunTime: null,
  nextRunTime: null,
  settings: {
    messageRetentionDays: 60,
    tracerouteRetentionDays: 30,
    routeSegmentRetentionDays: 30,
    neighborInfoRetentionDays: 30,
  },
};

function renderSection() {
  return render(
    <SaveBarProvider>
      <DatabaseMaintenanceSection />
      <SaveBar />
    </SaveBarProvider>,
  );
}

/** The four retention fields, in form order; the first is message retention. */
async function retentionFields(): Promise<HTMLInputElement[]> {
  return waitFor(() => {
    const fields = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    expect(fields).toHaveLength(4);
    expect(fields[0].value).toBe('60');
    return fields;
  });
}

const saveButton = () => screen.queryByRole('button', { name: 'common.save' }) as HTMLButtonElement | null;

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPost.mockResolvedValue({});
  apiGet.mockImplementation(async (url: string) => {
    if (url === '/api/health') return { databaseType: 'sqlite' };
    if (url === '/api/maintenance/status') return STATUS;
    if (url === '/api/maintenance/size') return { size: 1024 };
    return {};
  });
});

describe('DatabaseMaintenanceSection number fields (#5649)', () => {
  it('lets the user backspace 60 away and type 120, then saves it as before', async () => {
    const user = userEvent.setup();
    renderSection();
    const [messages] = await retentionFields();

    await user.click(messages);
    await user.keyboard('{End}{Backspace}{Backspace}');
    // Blank and still blank: nothing snapped it back to 30.
    expect(messages.value).toBe('');
    expect(messages).toHaveAttribute('aria-invalid', 'true');

    await user.keyboard('120');
    expect(messages.value).toBe('120');
    expect(messages).not.toHaveAttribute('aria-invalid');

    const save = await waitFor(() => {
      const button = saveButton();
      expect(button).not.toBeNull();
      expect(button!.disabled).toBe(false);
      return button!;
    });
    await user.click(save);

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [url, body] = apiPost.mock.calls[0];
    expect(url).toBe('/api/settings');
    // The server has always received these as numeric strings.
    expect(body.messageRetentionDays).toBe('120');
    expect(body.tracerouteRetentionDays).toBe('30');
    for (const key of ['messageRetentionDays', 'tracerouteRetentionDays', 'routeSegmentRetentionDays', 'neighborInfoRetentionDays']) {
      expect(body[key]).toMatch(/^\d+$/);
    }
  });

  it('turns Save off while a field is blank, says why, and turns it back on when fixed', async () => {
    const user = userEvent.setup();
    renderSection();
    const [messages, traceroutes] = await retentionFields();

    // A real edit elsewhere brings the bar up.
    await user.clear(traceroutes);
    await user.type(traceroutes, '45');
    await waitFor(() => expect(saveButton()).not.toBeNull());
    expect(saveButton()!.disabled).toBe(false);

    await user.clear(messages);
    await waitFor(() => expect(saveButton()!.disabled).toBe(true));
    // Not colour alone: the bar states the reason.
    expect(screen.getByText('savebar.fix_invalid_fields')).toBeInTheDocument();
    await user.click(saveButton()!);
    expect(apiPost).not.toHaveBeenCalled();

    await user.type(messages, '90');
    await waitFor(() => expect(saveButton()!.disabled).toBe(false));
    await user.click(saveButton()!);
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost.mock.calls[0][1]).toMatchObject({
      messageRetentionDays: '90',
      tracerouteRetentionDays: '45',
    });
  });

  it('blocks a retention below the 7-day floor instead of saving it', async () => {
    const user = userEvent.setup();
    renderSection();
    const [messages, traceroutes] = await retentionFields();

    await user.clear(traceroutes);
    await user.type(traceroutes, '45');
    await user.clear(messages);
    await user.type(messages, '3');

    expect(messages.value).toBe('3');
    expect(messages).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(saveButton()!.disabled).toBe(true));
    await user.click(saveButton()!);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('Dismiss puts a blank field back to its saved value', async () => {
    const user = userEvent.setup();
    renderSection();
    const [messages, traceroutes] = await retentionFields();

    await user.clear(traceroutes);
    await user.type(traceroutes, '45');
    await user.clear(messages);
    await waitFor(() => expect(saveButton()!.disabled).toBe(true));

    await user.click(screen.getByRole('button', { name: 'common.dismiss' }));
    await waitFor(() => expect(messages.value).toBe('60'));
    expect(traceroutes.value).toBe('30');
    expect(messages).not.toHaveAttribute('aria-invalid');
    expect(saveButton()).toBeNull();
  });
});
