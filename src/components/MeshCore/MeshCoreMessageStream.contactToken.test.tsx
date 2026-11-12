/**
 * @vitest-environment jsdom
 *
 * #6370: MeshCore One contact-share tokens in the MeshCore message stream.
 *  - Import: a valid token gets an import button that opens a modal; Import
 *    runs only when allowed, and a full radio list is confirmed in place.
 *  - Export: the composer's + menu inserts a picked contact's token, or this
 *    radio's own token, at the caret.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
vi.mock('../../hooks/useViewTranslations', () => ({
  useViewTranslations: () => ({
    translationSettings: { enabled: false, canTranslate: false, defaultLanguage: 'en', defaultOutgoingLanguage: 'en' },
    translatedMessages: {},
    translateMessage: vi.fn(),
    dismissTranslation: vi.fn(),
  }),
}));

import { MeshCoreMessageStream } from './MeshCoreMessageStream';
import type { MeshCoreMessage } from './hooks/useMeshCore';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

const KEY = '0a1b2c3d4e5f60718293a4b5c6d7e8f9' + '00112233445566778899aabbccddeeff';
const TOKEN = `<${KEY.toUpperCase()}:2:Ridge: North>`;
const SELF_KEY = 'ee'.repeat(32);

const msg = (text: string, id = 'm1'): MeshCoreMessage => ({
  id, fromPublicKey: 'channel-0', fromName: 'Bob', text, timestamp: Date.now(),
});
const box = () => screen.getByPlaceholderText('Type a message…') as HTMLTextAreaElement;

// insertIntoTextarea restores focus on the next frame; run it now.
beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

describe('contact-share token import (#6370)', () => {
  it('draws an import button next to a valid token and keeps the token text', () => {
    render(<MeshCoreMessageStream messages={[msg(`add ${TOKEN} please`)]} onSend={async () => true} />);
    expect(screen.getByText(TOKEN)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import contact Ridge: North' })).toBeTruthy();
  });

  it('draws no button for malformed tokens (type 4, short key, blank name)', () => {
    const bad = [
      `<${KEY}:4:Sensor>`,
      `<${KEY.slice(2)}:1:Short>`,
      `<${KEY}:1: >`,
    ].join(' ');
    render(<MeshCoreMessageStream messages={[msg(bad)]} onSend={async () => true} />);
    expect(screen.queryByRole('button', { name: /^Import contact/ })).toBeNull();
  });

  it('draws one button per token when a message carries several', () => {
    const other = `<${'ff'.repeat(32)}:1:Alice>`;
    render(<MeshCoreMessageStream messages={[msg(`${TOKEN} and ${other}`)]} onSend={async () => true} />);
    expect(screen.getAllByRole('button', { name: /^Import contact/ })).toHaveLength(2);
  });

  it('opens a modal with name, type and key, and imports on click', async () => {
    const onImport = vi.fn(async () => ({ success: true, status: 'added', evicted: [] }));
    render(
      <MeshCoreMessageStream
        messages={[msg(TOKEN)]}
        onSend={async () => true}
        contactTokenImport={{ onImport, canImport: true }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import contact Ridge: North' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Ridge: North')).toBeTruthy();
    expect(within(dialog).getByText('Repeater')).toBeTruthy();
    expect(within(dialog).getByText(KEY.toUpperCase())).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(within(dialog).getByText('Imported to the radio.')).toBeTruthy());
    expect(onImport).toHaveBeenCalledWith(TOKEN, false);
  });

  it('asks in place when the radio list is full, then retries with confirmFull', async () => {
    const onImport = vi.fn()
      .mockResolvedValueOnce({ success: false, code: 'CONTACT_TABLE_FULL_CONFIRM', error: 'The list is full (100/100).' })
      .mockResolvedValueOnce({ success: true, status: 'added', evicted: ['aa'] });
    render(
      <MeshCoreMessageStream
        messages={[msg(TOKEN)]}
        onSend={async () => true}
        contactTokenImport={{ onImport, canImport: true }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import contact Ridge: North' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByText(/The list is full \(100\/100\)/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Import anyway' }));
    await waitFor(() => expect(onImport).toHaveBeenLastCalledWith(TOKEN, true));
    await waitFor(() => expect(screen.getByText(/replaced 1 older/)).toBeTruthy());
  });

  it('disables Import with the reason when the source cannot import', () => {
    render(
      <MeshCoreMessageStream
        messages={[msg(TOKEN)]}
        onSend={async () => true}
        contactTokenImport={{ onImport: vi.fn(), canImport: false, disabledReason: 'Only a Companion source has a contact list to import into.' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import contact Ridge: North' }));
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Only a Companion source has a contact list to import into.')).toBeTruthy();
  });

  it("disables Import for the radio's own token", () => {
    const selfToken = `<${SELF_KEY.toUpperCase()}:1:Me>`;
    render(
      <MeshCoreMessageStream
        messages={[msg(selfToken)]}
        selfPublicKey={SELF_KEY}
        onSend={async () => true}
        contactTokenImport={{ onImport: vi.fn(), canImport: true }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import contact Me' }));
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("This is your radio's own contact.")).toBeTruthy();
  });
});

describe('composer + menu (#6370)', () => {
  const contacts: MeshCoreContact[] = [
    { publicKey: KEY, advName: 'Ridge', advType: 2 },
    { publicKey: 'cc'.repeat(32), advName: 'Alice', advType: 1 },
    { publicKey: 'dd'.repeat(32), advName: 'Club', advType: 3 },
    { publicKey: 'bb'.repeat(32), advName: 'Weather', advType: 4 }, // sensor: not shareable
    { publicKey: 'abc', advName: 'Truncated', advType: 1 }, // bad key: not shareable
  ];

  it('has no + button unless the parent enables contact sharing', () => {
    render(<MeshCoreMessageStream messages={[]} onSend={async () => true} />);
    expect(screen.queryByRole('button', { name: 'Insert' })).toBeNull();
  });

  it('Share my contact info inserts the self token at the caret', () => {
    render(
      <MeshCoreMessageStream
        messages={[]}
        onSend={async () => true}
        contactShare={{ selfNode: { publicKey: SELF_KEY, name: 'Base>Camp' } }}
      />,
    );
    fireEvent.change(box(), { target: { value: 'hi there' } });
    box().setSelectionRange(2, 2);
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Share my contact info/ }));
    expect(box().value).toBe(`hi <${SELF_KEY.toUpperCase()}:1:BaseCamp> there`);
  });

  it('disables Share my contact info without a 64-hex key (Repeater placeholder)', () => {
    render(
      <MeshCoreMessageStream
        messages={[]}
        onSend={async () => true}
        contactShare={{ selfNode: { publicKey: 'repeater', name: 'Rpt' } }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    expect((screen.getByRole('menuitem', { name: /Share my contact info/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Share contact lists Companions, Repeaters and Rooms, filters, and inserts the pick', () => {
    render(
      <MeshCoreMessageStream
        messages={[]}
        contacts={contacts}
        onSend={async () => true}
        contactShare={{ selfNode: { publicKey: SELF_KEY, name: 'Me' } }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Share contact/ }));
    const list = screen.getByRole('list', { name: 'Share contact' });
    const names = within(list).getAllByRole('button').map((b) => b.textContent);
    expect(names.some((n) => n?.includes('Alice'))).toBe(true);
    expect(names.some((n) => n?.includes('Club'))).toBe(true);
    expect(names.some((n) => n?.includes('Ridge'))).toBe(true);
    expect(names.some((n) => n?.includes('Weather') || n?.includes('Truncated'))).toBe(false);

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'rid' } });
    const filtered = within(screen.getByRole('list', { name: 'Share contact' })).getAllByRole('button');
    expect(filtered).toHaveLength(1);
    act(() => { fireEvent.click(filtered[0]); });

    expect(box().value).toBe(`<${KEY.toUpperCase()}:2:Ridge>`);
    expect(screen.queryByRole('list', { name: 'Share contact' })).toBeNull();
  });

  it('counts the inserted token toward the byte limit', () => {
    render(
      <MeshCoreMessageStream
        messages={[]}
        maxBytes={60}
        onSend={async () => true}
        contactShare={{ selfNode: { publicKey: SELF_KEY, name: 'Me' } }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Share my contact info/ }));
    // <64 hex:1:Me> = 71 bytes, over the 60-byte budget.
    expect(screen.getByText('71/60')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/remove 11 bytes/);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
