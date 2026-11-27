/**
 * @vitest-environment jsdom
 *
 * #6586 phase 3: UnifiedSendComposer passes its per-kind byte cap to the image dialog.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const PAYLOAD = 'MCOimg-test-payload';
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/SettingsContext', () => ({ useSettingsOptional: () => undefined }));
vi.mock('../McoImage/compose/McoImageComposeDialog', async () => {
  const React = await import('react');
  return {
    default: (p: { limit: number; onChoose(t: string): void }) =>
      React.createElement(
        'div',
        { role: 'dialog', 'data-limit': String(p.limit) },
        React.createElement('button', { onClick: () => p.onChoose('MCOimg-test-payload') }, 'choose-image'),
      ),
  };
});

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../../services/api', () => ({
  default: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
  },
}));

import UnifiedSendComposer from './UnifiedSendComposer';
import { createComposeDraftStore } from '../../contexts/composeDraftStore';
import { MAX_MESSAGE_BYTES } from '../../server/constants/meshtastic';
import { meshcoreChannelMaxBytes } from '../../utils/meshcoreMessageLimits';

type Ref = Record<string, unknown>;
const ref = (over: Ref): Ref => ({
  sourceId: 'a',
  sourceName: 'Alpha',
  channelNumber: 2,
  canSend: true,
  sendKind: 'meshtastic',
  sendBlockedReason: null,
  reactionsOutbound: null,
  ...over,
});

function setup(sources: Ref[]) {
  apiGet.mockImplementation(async (url: string) => {
    if (url === '/api/unified/senders') return { success: true, data: { channels: [{ name: '#Public', sources }] } };
    if (url.includes('/meshcore/status')) return { data: { localNode: { name: 'Alice' } } };
    return {};
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createComposeDraftStore();
  render(
    <QueryClientProvider client={client}>
      <UnifiedSendComposer
        channelName="#Public"
        draftStore={store}
        onSent={vi.fn()}
        target={null}
        onClearTarget={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return store;
}

async function insertImage() {
  const plus = await screen.findByRole('button', { name: 'Insert' });
  fireEvent.click(plus);
  fireEvent.click(screen.getByRole('menuitem', { name: /Insert image/ }));
  const dlg = await screen.findByRole('dialog');
  const limit = dlg.getAttribute('data-limit');
  fireEvent.click(screen.getByText('choose-image'));
  return Number(limit);
}

describe('UnifiedSendComposer insert image', () => {
  beforeEach(() => {
    localStorage.clear();
    apiGet.mockReset();
    apiPost.mockReset();
    apiPost.mockResolvedValue({ success: true });
  });

  it('meshtastic: limit is the Meshtastic cap, and send posts exactly the payload', async () => {
    const store = setup([ref({})]);
    await screen.findByLabelText('Send from');
    expect(await insertImage()).toBe(MAX_MESSAGE_BYTES);
    expect(store.get()).toBe(PAYLOAD);
    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/messages/send', { sourceId: 'a', text: PAYLOAD, channel: 2 }),
    );
  });

  it('meshcore: limit is the channel cap for the node name', async () => {
    setup([ref({ sourceId: 'c', sendKind: 'meshcore', channelNumber: 1 })]);
    await screen.findByLabelText('Send from');
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('/meshcore/status')));
    await waitFor(async () => {
      // the name arrives after the status call resolves
      fireEvent.click(await screen.findByRole('button', { name: 'Insert' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Insert image/ }));
      const dlg = await screen.findByRole('dialog');
      expect(Number(dlg.getAttribute('data-limit'))).toBe(meshcoreChannelMaxBytes('Alice'));
    });
  });
});
