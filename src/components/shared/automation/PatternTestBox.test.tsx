/**
 * @vitest-environment jsdom
 *
 * PatternTestBox (#5808): lists matches per line, previews the response,
 * flags shadowed matches in `first` mode, and never touches the network.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { PatternTestBox, type PatternTestResult } from './PatternTestBox';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../../test/mockI18n');
  return createReactI18nextMock();
});

interface Rule { id: string; re: RegExp; reply: string }
const rules: Rule[] = [
  { id: 'a', re: /^ping/i, reply: 'pong' },
  { id: 'b', re: /ping/i, reply: 'also pong' },
  { id: 'c', re: /^weather/i, reply: 'sunny' },
];
const match = (r: Rule, text: string): PatternTestResult =>
  r.re.test(text) ? { matched: true, response: r.reply } : { matched: false };

function renderBox(mode: 'first' | 'all') {
  return render(
    <PatternTestBox
      triggers={rules}
      mode={mode}
      getKey={(r) => r.id}
      getLabel={(r) => `rule ${r.id}`}
      match={match}
    />,
  );
}

const type = (text: string) => fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });

describe('PatternTestBox', () => {
  afterEach(() => vi.restoreAllMocks());

  it('tests each line and shows the matching triggers with their reply', () => {
    renderBox('all');
    type('weather today\nhello');
    const lines = screen.getAllByTestId('pattern-test-line');
    expect(lines).toHaveLength(2);
    expect(within(lines[0]).getByText('rule c')).toBeInTheDocument();
    expect(within(lines[0]).getByText('sunny')).toBeInTheDocument();
    expect(within(lines[1]).getByText(/no trigger matches/i)).toBeInTheDocument();
  });

  it('`all` mode: every match replies', () => {
    renderBox('all');
    type('ping');
    const hits = screen.getAllByTestId('pattern-test-hit');
    expect(hits).toHaveLength(2);
    expect(screen.getByText('pong')).toBeInTheDocument();
    expect(screen.getByText('also pong')).toBeInTheDocument();
    expect(screen.queryByText(/only the first one replies/i)).toBeNull();
  });

  it('`first` mode: later matches are shadowed and get no reply preview', () => {
    renderBox('first');
    type('ping');
    expect(screen.getByText(/2 triggers match; only the first one replies/i)).toBeInTheDocument();
    expect(screen.getByText('pong')).toBeInTheDocument();
    expect(screen.queryByText('also pong')).toBeNull();
  });

  it('is purely local: typing never calls fetch or XHR', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, 'open');
    renderBox('first');
    type('ping\nweather\nnothing');
    expect(screen.getAllByTestId('pattern-test-line')).toHaveLength(3);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
  });
});
