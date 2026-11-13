import { describe, it, expect } from 'vitest';
import { insertAtCaret } from './insertAtCaret';

describe('insertAtCaret', () => {
  it('inserts at the caret', () => {
    expect(insertAtCaret('ac', 'b', 1, 1)).toEqual({ next: 'abc', caret: 2 });
  });

  it('replaces a selection', () => {
    expect(insertAtCaret('a--d', 'bc', 1, 3)).toEqual({ next: 'abcd', caret: 3 });
  });

  it('clamps out-of-range positions to the end', () => {
    expect(insertAtCaret('ab', 'c', 99, 99)).toEqual({ next: 'abc', caret: 3 });
  });

  it('pads with spaces only where the text would touch a word', () => {
    expect(insertAtCaret('hi there', 'T', 2, 2, { pad: true })).toEqual({ next: 'hi T there', caret: 4 });
    expect(insertAtCaret('hithere', 'T', 2, 2, { pad: true })).toEqual({ next: 'hi T there', caret: 5 });
    expect(insertAtCaret('', 'T', 0, 0, { pad: true })).toEqual({ next: 'T', caret: 1 });
    expect(insertAtCaret('hi', 'T', 2, 2, { pad: true })).toEqual({ next: 'hi T', caret: 4 });
  });

  it('does not pad without the option (emoji insert)', () => {
    expect(insertAtCaret('hithere', 'X', 2, 2)).toEqual({ next: 'hiXthere', caret: 3 });
  });
});
