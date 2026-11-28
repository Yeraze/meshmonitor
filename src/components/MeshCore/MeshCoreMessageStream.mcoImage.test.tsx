/**
 * @vitest-environment jsdom
 *
 * MCOimg (#6586) in the MeshCore stream: drawn as an image, sender and time
 * intact; bridged-prefix bodies stay text; no Translate button on image rows.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../diagnostics/MessageDetailsModal', () => ({
  default: () => <div />,
}));

const { idsSeen } = vi.hoisted(() => ({ idsSeen: { last: [] as string[] } }));
vi.mock('../../hooks/useViewTranslations', () => ({
  useViewTranslations: (_sourceId: unknown, ids: string[]) => {
    idsSeen.last = ids;
    return {
      translationSettings: { canTranslate: true, enabled: true, defaultLanguage: 'en' },
      translatedMessages: {},
      translateMessage: vi.fn(),
      dismissTranslation: vi.fn(),
    };
  },
}));

import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import type { MeshCoreMessage } from './hooks/useMeshCore';
import { PUBLIC_INSTANCE_HIDDEN_TEXT } from '../../utils/publicInstanceMode';
import fixtures from '../../utils/mcoImage/__fixtures__/v4-differential-fixtures.json';

const SELF = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);
const SAMPLE = 'im3:2nTxb8bL@u#f!+~Xv(}LpQrfRJ+tBMPKr*JTvu0t6EbJbeD"%qhto7o)L(:>=5Mf%u}"[7EE%MACq%H"EA';

const IM4 = fixtures.entries.find((e) => e.name === 'reporter-6586')!.text;

const msg = (id: string, text: string, over: Partial<MeshCoreMessage> = {}): MeshCoreMessage => ({
  id, fromPublicKey: OTHER, toPublicKey: 'channel-1', text, timestamp: T0, fromName: 'Alice', ...over,
});

const renderStream = (messages: MeshCoreMessage[]) =>
  render(<MeshCoreMessageStream messages={messages} selfPublicKey={SELF} onSend={async () => true} />);

describe('MeshCoreMessageStream MCOimg (#6586)', () => {
  it('draws an im3 message as an image with the sender intact', async () => {
    const { container } = renderStream([msg('m1', SAMPLE)]);
    expect(await screen.findByTestId('mco-image', {}, { timeout: 5000 })).toBeTruthy();
    expect(container.textContent).toContain('Alice');
  });

  it('keeps a bridged-prefix body as text', () => {
    const { container } = renderStream([msg('m2', `MT@Bob: ${SAMPLE}`)]);
    expect(screen.queryByTestId('mco-image')).toBeNull();
    expect(screen.queryByTestId('mco-image-text')).toBeNull();
    expect(container.textContent).toContain('MT@Bob: im3:');
  });

  it('shows the hidden placeholder, never an image', () => {
    renderStream([msg('m3', PUBLIC_INSTANCE_HIDDEN_TEXT)]);
    expect(screen.getByTestId('public-hidden-text')).toBeTruthy();
    expect(screen.queryByTestId('mco-image')).toBeNull();
  });

  it('offers Translate on plain text only, not on MCO or SPIP rows', () => {
    const { container } = renderStream([
      msg('plain', 'hello there', { timestamp: T0 }),
      msg('mco', SAMPLE, { timestamp: T0 + 1000 }),
      msg('spip', '3:yzyzyzyzy', { timestamp: T0 + 2000 }),
    ]);
    expect(idsSeen.last).toEqual(['plain']);
    expect(container.querySelectorAll('.translate-button')).toHaveLength(1);
  });

  it('draws an im4 message as an image and hides Translate', async () => {
    const { container } = renderStream([msg('im4', IM4)]);
    const img = await screen.findByTestId('mco-image', {}, { timeout: 5000 });
    expect(img.getAttribute('data-format')).toBe('im4');
    expect(img.querySelector('[role="img"]')!.getAttribute('aria-label')).toContain('Queens Weather');
    expect(idsSeen.last).toEqual([]);
    expect(container.querySelectorAll('.translate-button')).toHaveLength(0);
  });
});
