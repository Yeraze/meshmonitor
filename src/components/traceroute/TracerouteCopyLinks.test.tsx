/**
 * @vitest-environment jsdom
 *
 * Coverage for `TracerouteCopyLinks` — the Copy Forward/Return/Both text
 * links in the Node Details traceroute box.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import enLocale from '../../../public/locales/en.json';
import { TracerouteCopyLinks } from './TracerouteCopyLinks';
import type { DeviceInfo } from '../../types/device';

// -----------------------------------------------------------------------
// Real-translation react-i18next mock (mirrors
// TracerouteParticipationPicker.test.tsx's pattern) — the global setup.ts
// mock returns the raw key for `t(key, defaultValue)` calls, which this
// component uses throughout for its link/button labels.
// -----------------------------------------------------------------------
const enDict = enLocale as Record<string, unknown>;
function lookupEnDefault(key: string): string | undefined {
  const value = enDict[key];
  return typeof value === 'string' ? value : undefined;
}

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) => lookupEnDefault(key) ?? defaultValue ?? key,
  }),
}));

const FROM = 100;
const TO = 200;

const nodes: DeviceInfo[] = [
  { nodeNum: FROM, user: { id: '!64', longName: 'Node A', shortName: 'NDEA' } } as DeviceInfo,
  { nodeNum: TO, user: { id: '!c8', longName: 'Node B', shortName: 'NDEB' } } as DeviceInfo,
];

describe('TracerouteCopyLinks', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when neither leg has usable data', () => {
    const { container } = render(
      <TracerouteCopyLinks
        route={null}
        routeBack={null}
        snrTowards={null}
        snrBack={null}
        fromNodeNum={FROM}
        toNodeNum={TO}
        nodes={nodes}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows only Copy Forward when the return leg has no data', () => {
    render(
      <TracerouteCopyLinks
        route="[]"
        routeBack={null}
        snrTowards="[40]"
        snrBack={null}
        fromNodeNum={FROM}
        toNodeNum={TO}
        nodes={nodes}
      />,
    );
    expect(screen.getByText('Copy Forward')).toBeInTheDocument();
    expect(screen.queryByText('Copy Return')).not.toBeInTheDocument();
    expect(screen.queryByText('Copy Both')).not.toBeInTheDocument();
  });

  it('shows only Copy Return when the forward leg has no data', () => {
    render(
      <TracerouteCopyLinks
        route={null}
        routeBack="[]"
        snrTowards={null}
        snrBack="[40]"
        fromNodeNum={FROM}
        toNodeNum={TO}
        nodes={nodes}
      />,
    );
    expect(screen.queryByText('Copy Forward')).not.toBeInTheDocument();
    expect(screen.getByText('Copy Return')).toBeInTheDocument();
    expect(screen.queryByText('Copy Both')).not.toBeInTheDocument();
  });

  it('shows all three links when both legs have data', () => {
    render(
      <TracerouteCopyLinks
        route="[]"
        routeBack="[]"
        snrTowards="[40]"
        snrBack="[44]"
        fromNodeNum={FROM}
        toNodeNum={TO}
        nodes={nodes}
      />,
    );
    expect(screen.getByText('Copy Forward')).toBeInTheDocument();
    expect(screen.getByText('Copy Return')).toBeInTheDocument();
    expect(screen.getByText('Copy Both')).toBeInTheDocument();
  });

  it('copies the exact forward text and shows a Copied! confirmation that clears after ~2s', async () => {
    vi.useFakeTimers();
    render(
      <TracerouteCopyLinks
        route="[]"
        routeBack={null}
        snrTowards="[40]"
        snrBack={null}
        fromNodeNum={FROM}
        toNodeNum={TO}
        nodes={nodes}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('Copy Forward'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'Forward: Node A [NDEA] → Node B [NDEB] (10.0 dB)',
    );
    expect(screen.getByText('Copied!')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
  });

  it('copies Return: <line> and Both: forward+return joined with a newline', async () => {
    render(
      <TracerouteCopyLinks
        route="[]"
        routeBack="[]"
        snrTowards="[40]"
        snrBack="[44]"
        fromNodeNum={FROM}
        toNodeNum={TO}
        nodes={nodes}
      />,
    );

    fireEvent.click(screen.getByText('Copy Return'));
    await screen.findByText('Copied!');
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      'Return: Node B [NDEB] → Node A [NDEA] (11.0 dB)',
    );

    fireEvent.click(screen.getByText('Copy Both'));
    await screen.findByText('Copied!');
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      'Forward: Node A [NDEA] → Node B [NDEB] (10.0 dB)\n' +
      'Return: Node B [NDEB] → Node A [NDEA] (11.0 dB)',
    );
  });

  it('opens the fallback modal with the text when clipboard is unavailable (insecure context)', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });

    render(
      <TracerouteCopyLinks
        route="[]"
        routeBack={null}
        snrTowards="[40]"
        snrBack={null}
        fromNodeNum={FROM}
        toNodeNum={TO}
        nodes={nodes}
      />,
    );

    fireEvent.click(screen.getByText('Copy Forward'));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();

    const textarea = await screen.findByRole('textbox') as HTMLTextAreaElement;
    expect(textarea).toHaveValue('Forward: Node A [NDEA] → Node B [NDEB] (10.0 dB)');
    expect(textarea).toHaveAttribute('readonly');
    expect(document.activeElement).toBe(textarea);

    fireEvent.click(screen.getByText('Close'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('opens the fallback modal when navigator.clipboard.writeText rejects', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });

    render(
      <TracerouteCopyLinks
        route="[]"
        routeBack={null}
        snrTowards="[40]"
        snrBack={null}
        fromNodeNum={FROM}
        toNodeNum={TO}
        nodes={nodes}
      />,
    );

    fireEvent.click(screen.getByText('Copy Forward'));

    const textarea = await screen.findByRole('textbox') as HTMLTextAreaElement;
    expect(textarea).toHaveValue('Forward: Node A [NDEA] → Node B [NDEB] (10.0 dB)');
    expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
  });
});
