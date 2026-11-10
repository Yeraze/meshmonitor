/**
 * @vitest-environment jsdom
 *
 * Save as preset blocks a root the server would refuse (#6338), after the same
 * trim and trailing-slash strip the server applies, and shows the server's
 * refusal in the user's language.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock((key: string) => `<${key}>`);
});
const createMock = vi.fn();
vi.mock('../../hooks/useMqttBrokerPresets', () => ({
  useCreateBrokerPreset: () => ({ mutateAsync: createMock, isPending: false }),
  useUpdateBrokerPreset: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteBrokerPreset: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('./MqttRootFinder', () => ({ MqttRootFinder: () => null }));
vi.mock('../common/Modal', () => ({
  default: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) => (isOpen ? <div>{children}</div> : null),
}));

import { SaveBrokerPresetDialog } from './SavedBrokerPresetDialogs';
import { ApiError } from '../../services/api';

const draft = (rootTopic: string) => ({ host: 'broker.test', port: 1883, tls: false, username: '', password: '', rootTopic });

function open(rootTopic: string) {
  render(<SaveBrokerPresetDialog isOpen onClose={vi.fn()} draft={draft(rootTopic)} />);
  fireEvent.change(document.getElementById('save-broker-preset-name') as HTMLInputElement, { target: { value: 'Mine' } });
  return screen.getByTestId('save-broker-preset-submit') as HTMLButtonElement;
}

beforeEach(() => {
  createMock.mockReset();
});

describe('SaveBrokerPresetDialog root gate', () => {
  it.each(['msh/#', 'msh/US/2', 'msh//US'])('blocks Save for %j', (root) => {
    expect(open(root).disabled).toBe(true);
  });

  it.each(['', 'msh/US', 'msh/US/', ' msh/US '])('allows Save for %j', (root) => {
    expect(open(root).disabled).toBe(false);
  });

  it("shows the server's refusal in the user's language", async () => {
    createMock.mockRejectedValue(
      new ApiError('A root cannot contain + or #.', 400, { code: 'INVALID_MQTT_ROOT', body: { reason: 'WILDCARD' } }),
    );
    fireEvent.click(open('msh/US'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('<mqtt_root_finder.validation.WILDCARD>'));
  });
});
