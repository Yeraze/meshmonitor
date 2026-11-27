/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { EncodingView, McoImageComposeState, UseMcoImageComposeOptions } from './useMcoImageCompose.js';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../../test/mockI18n');
  return createReactI18nextMock();
});

const mocks = vi.hoisted(() => ({
  decode: vi.fn(),
  state: null as unknown as McoImageComposeState,
  lastOpts: null as unknown as UseMcoImageComposeOptions,
}));

vi.mock('./decodeImageFile.js', async (orig) => ({
  ...(await orig<typeof import('./decodeImageFile.js')>()),
  decodeImageFile: mocks.decode,
}));
vi.mock('./useMcoImageCompose.js', () => ({
  useMcoImageCompose: (o: UseMcoImageComposeOptions) => {
    mocks.lastOpts = o;
    return mocks.state;
  },
}));
vi.mock('../McoImage', () => ({ default: ({ payload }: { payload: string }) => <div data-testid="preview">{payload}</div> }));

import McoImageComposeDialog from './McoImageComposeDialog';
import { McoImageFileError } from './decodeImageFile.js';

const view = (over: Partial<EncodingView>): EncodingView => ({
  status: 'ready', text: 'im3:abc', bytes: 143, w: 32, h: 24, profile: 2, fits: true, ...over,
});
const idle = view({ status: 'idle', text: null, bytes: null, w: null, h: null, profile: null, fits: false });
const source = { width: 64, height: 48, rgba: new Uint8ClampedArray(64 * 48 * 4) };

function renderDialog(props: Partial<React.ComponentProps<typeof McoImageComposeDialog>> = {}) {
  const onChoose = vi.fn();
  const onClose = vi.fn();
  render(<McoImageComposeDialog open limit={151} draftNotEmpty={false} onChoose={onChoose} onClose={onClose} {...props} />);
  return { onChoose, onClose };
}

async function pickFile(name = 'a.png', type = 'image/png') {
  const input = screen.getByTestId('mco-file-input') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([new Uint8Array(1)], name, { type })] } });
}

describe('McoImageComposeDialog', () => {
  beforeEach(() => {
    mocks.decode.mockReset();
    mocks.state = { im3: idle, im4: idle, highTimedOut: false };
  });

  it('renders nothing when closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the dialog, the limit and the one-message hint', () => {
    renderDialog();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Limit for this conversation: 151 bytes')).toBeTruthy();
    expect(screen.getByText(/Sent as one ordinary text message/)).toBeTruthy();
    expect(screen.queryByText('Replaces your current draft.')).toBeNull();
  });

  it('shows the replace-draft note only when the draft is not empty', () => {
    renderDialog({ draftNotEmpty: true });
    expect(screen.getByText('Replaces your current draft.')).toBeTruthy();
  });

  it('reports a rejected file type and size', async () => {
    renderDialog();
    mocks.decode.mockRejectedValueOnce(new McoImageFileError('type'));
    await pickFile('a.gif', 'image/gif');
    expect((await screen.findByRole('alert')).textContent).toBe('Choose a PNG or JPEG image.');
    mocks.decode.mockRejectedValueOnce(new McoImageFileError('size'));
    await pickFile();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/too large/));
    mocks.decode.mockRejectedValueOnce(new McoImageFileError('decode'));
    await pickFile();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not be read/));
  });

  it('renders both panels with byte counts and Use replaces the draft via onChoose', async () => {
    mocks.state = {
      im3: view({ text: 'im3:good', bytes: 143 }),
      im4: view({ text: 'im4:big', bytes: 160, fits: false, status: 'nofit' }),
      highTimedOut: false,
    };
    mocks.decode.mockResolvedValue(source);
    const { onChoose } = renderDialog();
    await pickFile();
    const p3 = await screen.findByTestId('mco-panel-im3');
    const p4 = screen.getByTestId('mco-panel-im4');
    expect(within(p3).getByText('143 / 151 bytes')).toBeTruthy();
    expect(within(p3).getByTestId('preview').textContent).toBe('im3:good');
    expect(within(p4).getByText('160 / 151 bytes')).toBeTruthy();
    expect(within(p4).getByText('Over by 9 bytes')).toBeTruthy();
    const use4 = within(p4).getByRole('button', { name: 'Use IM4' }) as HTMLButtonElement;
    expect(use4.disabled).toBe(true);
    expect(within(p4).getByText('Does not fit in this conversation.')).toBeTruthy();
    fireEvent.click(within(p3).getByRole('button', { name: 'Use IM3' }));
    expect(onChoose).toHaveBeenCalledWith('im3:good');
  });

  it('keeps Use enabled while High optimizing and disabled while nothing is ready', async () => {
    mocks.state = { im3: view({ status: 'optimizing' }), im4: view({ status: 'searching', text: null, bytes: null, fits: false }), highTimedOut: false };
    mocks.decode.mockResolvedValue(source);
    renderDialog();
    await pickFile();
    const p3 = await screen.findByTestId('mco-panel-im3');
    expect((within(p3).getByRole('button', { name: 'Use IM3' }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(p3).getByText('Optimizing…')).toBeTruthy();
    const p4 = screen.getByTestId('mco-panel-im4');
    expect((within(p4).getByRole('button', { name: 'Use IM4' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(p4).getByText('Still working on a result.')).toBeTruthy();
  });

  it('manual controls change the request, dither is off by default', async () => {
    mocks.decode.mockResolvedValue(source);
    renderDialog();
    await pickFile();
    await screen.findByTestId('mco-panel-im3');
    expect(mocks.lastOpts.mode).toBe('auto');
    fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
    expect(mocks.lastOpts.mode).toBe('manual');
    expect(mocks.lastOpts.manual.dither).toBe(false);
    fireEvent.change(screen.getByLabelText(/Palette/), { target: { value: '5' } });
    expect(mocks.lastOpts.manual.profile).toBe(5);
    fireEvent.click(screen.getByLabelText('Dither'));
    expect(mocks.lastOpts.manual.dither).toBe(true);
    fireEvent.change(screen.getByLabelText(/Size/), { target: { value: '0' } });
    expect(mocks.lastOpts.manual.size).toBe(8);
  });
});
