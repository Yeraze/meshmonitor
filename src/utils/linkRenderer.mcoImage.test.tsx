// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});

import { renderMessageWithLinks, extractUrls } from './linkRenderer';
import { PUBLIC_INSTANCE_HIDDEN_TEXT } from './publicInstanceMode';
import fixtures from './mcoImage/__fixtures__/v4-differential-fixtures.json';

type Fx = { name: string; text: string; result: string };
const entries = fixtures.entries as Fx[];
const IM4 = entries.find((e) => e.name === 'reporter-6586')!.text;
const IM4_DAMAGED = entries.find((e) => e.name === 'mutant-invalid')!.text;
const IM4_UNSUPPORTED = entries.find((e) => e.name === 'mutant-unsupported')!.text;

const SAMPLE = 'im3:2nTxb8bL@u#f!+~Xv(}LpQrfRJ+tBMPKr*JTvu0t6EbJbeD"%qhto7o)L(:>=5Mf%u}"[7EE%MACq%H"EA';

describe('renderMessageWithLinks MCOimg (#6586)', () => {
  it('draws the sample as an image', async () => {
    render(<div>{renderMessageWithLinks(SAMPLE)}</div>);
    expect(await screen.findByTestId('mco-image')).toBeTruthy();
  });

  it.each([
    ['mid-sentence', `look ${SAMPLE}`],
    ['uppercase prefix', SAMPLE.replace('im3:', 'IM3:')],
    ['mixed text', `${SAMPLE} thanks`],
  ])('leaves %s as plain text', (_n, text) => {
    const { container } = render(<div>{renderMessageWithLinks(text)}</div>);
    expect(screen.queryByTestId('mco-image')).toBeNull();
    expect(screen.queryByTestId('mco-image-text')).toBeNull();
    expect(container.textContent).toContain(text);
  });

  it('lets the public hidden placeholder win', () => {
    render(<div>{renderMessageWithLinks(PUBLIC_INSTANCE_HIDDEN_TEXT)}</div>);
    expect(screen.getByTestId('public-hidden-text')).toBeTruthy();
    expect(screen.queryByTestId('mco-image')).toBeNull();
    expect(screen.queryByTestId('mco-image-text')).toBeNull();
  });

  it('draws the reporter IM4 sample with its caption in the label', async () => {
    render(<div>{renderMessageWithLinks(IM4)}</div>);
    const img = await screen.findByTestId('mco-image');
    expect(img.getAttribute('data-format')).toBe('im4');
    expect(img.querySelector('[role="img"]')!.getAttribute('aria-label')).toContain('Queens Weather');
  });

  it.each([
    ['damaged', IM4_DAMAGED],
    ['unsupported', IM4_UNSUPPORTED],
  ])('shows a %s IM4 payload as the exact text', async (_n, text) => {
    render(<div>{renderMessageWithLinks(text)}</div>);
    const el = await screen.findByTestId('mco-image-text');
    expect(el.textContent).toBe(text);
    expect(screen.queryByTestId('mco-image')).toBeNull();
  });

  it('leaves "hi im4:..." as plain text', () => {
    const text = `hi ${IM4}`;
    const { container } = render(<div>{renderMessageWithLinks(text)}</div>);
    expect(screen.queryByTestId('mco-image')).toBeNull();
    expect(screen.queryByTestId('mco-image-text')).toBeNull();
    expect(container.textContent).toContain(text);
  });

  it('still draws SPIP', () => {
    const { container } = render(<div>{renderMessageWithLinks('3:yzyzyzyzy')}</div>);
    expect(container.querySelector('canvas, img, svg, [data-testid^="spip"]')).not.toBeNull();
  });
});

describe('extractUrls with MCOimg (#6586)', () => {
  it('returns nothing for a payload that holds http:// or www.', () => {
    expect(extractUrls('im3:abcdhttp://ab.cdEFGH')).toEqual([]);
    expect(extractUrls('im3:abcdwww.abEFGH')).toEqual([]);
  });

  it('still finds a URL in normal text', () => {
    expect(extractUrls('see https://example.com now')).toEqual(['https://example.com']);
  });
});
