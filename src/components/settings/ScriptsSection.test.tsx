/**
 * @vitest-environment jsdom
 *
 * Scripts inventory section (issue #4942): renders scripts with usage badges,
 * flags orphaned scripts as Unused, and gates delete behind a confirm step.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockShowToast = vi.hoisted(() => vi.fn());
vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

const mockCsrfFetch = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => mockCsrfFetch,
}));

const mockApiGet = vi.hoisted(() => vi.fn());
vi.mock('../../services/api', () => ({
  default: { get: mockApiGet },
}));

// Stub the icons and the dependencies panel so the test stays focused on this
// section's own behavior (the panel fetches on mount otherwise).
vi.mock('../icons', () => ({
  UiIcon: () => null,
}));
vi.mock('../auto-responder/ScriptDependenciesPanel', () => ({
  default: () => null,
}));

import ScriptsSection from './ScriptsSection';

const inventory = {
  scripts: [
    {
      path: '/data/scripts/weather.py',
      filename: 'weather.py',
      name: 'Weather',
      language: 'Python',
      version: '2.1',
      author: 'Alice',
      sizeBytes: 512,
      lastModified: 1_700_000_000_000,
      usedBy: [
        { type: 'auto-responder', protocol: 'meshtastic', sourceId: 's1', sourceName: 'Node A', triggerId: 't1', triggerName: 'weather', enabled: true },
      ],
    },
    {
      path: '/data/scripts/orphan.sh',
      filename: 'orphan.sh',
      language: 'Shell',
      sizeBytes: 20,
      lastModified: 1_700_000_000_000,
      usedBy: [],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApiGet.mockResolvedValue(inventory);
  mockCsrfFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
});

describe('ScriptsSection', () => {
  it('renders scripts with in-use and unused badges', async () => {
    render(<ScriptsSection baseUrl="" />);

    await waitFor(() => expect(screen.getByText('Weather')).toBeInTheDocument());
    expect(screen.getAllByText('orphan.sh').length).toBeGreaterThan(0);
    // "In use"/"Unused" also appear as filter <option> labels, so match >= 1.
    expect(screen.getAllByText('In use').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Unused').length).toBeGreaterThan(0);
    // Usage reference is described.
    expect(screen.getByText(/Auto Responder "weather" · Node A/)).toBeInTheDocument();
  });

  it('filters to unused scripts', async () => {
    render(<ScriptsSection baseUrl="" />);
    await waitFor(() => expect(screen.getByText('Weather')).toBeInTheDocument());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'unused' } });

    expect(screen.queryByText('Weather')).not.toBeInTheDocument();
    expect(screen.getAllByText('orphan.sh').length).toBeGreaterThan(0);
  });

  it('requires confirmation before deleting and warns when in use', async () => {
    render(<ScriptsSection baseUrl="" />);
    await waitFor(() => expect(screen.getByText('Weather')).toBeInTheDocument());

    // Click the delete button on the in-use script's row.
    const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
    fireEvent.click(deleteButtons[0]);

    // Warning mentions it is in use, and no request has fired yet.
    expect(screen.getByText(/used by 1 automation/i)).toBeInTheDocument();
    expect(mockCsrfFetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /delete anyway/i }));

    await waitFor(() =>
      expect(mockCsrfFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/scripts/weather.py'),
        expect.objectContaining({ method: 'DELETE' })
      )
    );
  });

  it('hides write controls when canWrite is false', async () => {
    render(<ScriptsSection baseUrl="" canWrite={false} />);
    await waitFor(() => expect(screen.getByText('Weather')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /import script/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });
});
