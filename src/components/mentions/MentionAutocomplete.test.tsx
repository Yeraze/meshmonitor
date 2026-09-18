/**
 * @vitest-environment jsdom
 *
 * The `@` mention popup and the hook that drives it (#5276).
 *
 * The keyboard contract is the part worth pinning: an open list must claim
 * Enter before the composer's send handler sees it, or picking a node would
 * fire off a half-written message.
 */
import { useRef, useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MentionAutocomplete from './MentionAutocomplete';
import { useMentionAutocomplete } from '../../hooks/useMentionAutocomplete';
import type { MentionCandidate } from '../../utils/mentions';

const NODES: MentionCandidate[] = [
  { id: '!ffccee11', longName: 'EOC Operator', shortName: 'EOC1' },
  { id: '!00a1b2c3', longName: 'Field Node East', shortName: 'FNE' },
];

beforeEach(() => {
  // jsdom has no rAF timing worth waiting on; run the caret restore at once.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
});

/** A minimal composer wired the way the real ones are. */
function Composer({ onSend, buildInsertion }: { onSend?: () => void; buildInsertion?: (c: MentionCandidate) => string }) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentionAutocomplete({
    value,
    onChange: setValue,
    textareaRef: ref,
    candidates: NODES,
    buildInsertion,
  });

  return (
    <div>
      <MentionAutocomplete
        id="test-mentions"
        candidates={mentions.suggestions}
        activeIndex={mentions.activeIndex}
        onHover={mentions.setActiveIndex}
        onSelect={mentions.select}
      />
      <textarea
        ref={ref}
        aria-label="composer"
        value={value}
        onChange={e => {
          setValue(e.target.value);
          mentions.handleChange(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={e => {
          if (mentions.handleKeyDown(e)) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSend?.();
          }
        }}
      />
    </div>
  );
}

function type(text: string) {
  const box = screen.getByLabelText('composer') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text, selectionStart: text.length } });
  return box;
}

describe('mention autocomplete (#5276)', () => {
  it('stays closed until an @ starts a word', () => {
    render(<Composer />);
    type('hello');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    type('mail me@host');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('offers every node for a bare @, and filters as you type', () => {
    render(<Composer />);
    type('@');
    expect(screen.getAllByRole('option')).toHaveLength(2);

    type('@fie');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Field Node East');
  });

  it('inserts the wire token, not the display name', () => {
    render(<Composer />);
    type('hey @eoc');
    fireEvent.click(screen.getByRole('option', { name: /EOC Operator/ }));

    expect((screen.getByLabelText('composer') as HTMLTextAreaElement).value).toBe('hey @!ffccee11 ');
  });

  it('lets a caller insert its own format, for MeshCore', () => {
    render(<Composer buildInsertion={c => `@[${c.longName}] `} />);
    type('@fie');
    fireEvent.click(screen.getByRole('option', { name: /Field Node East/ }));

    expect((screen.getByLabelText('composer') as HTMLTextAreaElement).value).toBe('@[Field Node East] ');
  });

  it('takes Enter to pick a node instead of sending', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = type('@eoc');
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe('@!ffccee11 ');
  });

  it('sends on Enter once the list is closed', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = type('no mention here');
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('moves the highlight with the arrow keys and picks with Tab', () => {
    render(<Composer />);
    const box = type('@');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Tab' });

    expect((box as HTMLTextAreaElement).value).toBe('@!00a1b2c3 ');
  });

  it('closes on Escape without changing the draft', () => {
    render(<Composer />);
    const box = type('@eoc');
    fireEvent.keyDown(box, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect((box as HTMLTextAreaElement).value).toBe('@eoc');
  });

  it('shows nothing when no node matches', () => {
    render(<Composer />);
    type('@zzzz');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
