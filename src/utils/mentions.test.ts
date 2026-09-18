import { describe, it, expect } from 'vitest';
import {
  applyMention,
  filterMentionCandidates,
  findMentionQuery,
  mentionToken,
  mentionedNodeIds,
  nodeIdFromNum,
  textMentionsNode,
} from './mentions';

const NODES = [
  { id: '!ffccee11', longName: 'EOC Operator', shortName: 'EOC1' },
  { id: '!00a1b2c3', longName: 'Field Node East', shortName: 'FNE' },
  { id: '!deadbeef', longName: 'Solar Relay', shortName: 'SOLR' },
];

describe('mention tokens (#5276)', () => {
  it('builds the id form both official apps expect', () => {
    expect(nodeIdFromNum(0xffccee11)).toBe('!ffccee11');
    // A node number above 2^31 must stay unsigned, not become negative hex.
    expect(nodeIdFromNum(-2)).toBe('!fffffffe');
    expect(nodeIdFromNum(0x7b)).toBe('!0000007b');
  });

  it('emits lowercase hex with a trailing space', () => {
    // Lowercase satisfies iOS, which matches lowercase only; the space is what
    // Android appends and what a typist expects next.
    expect(mentionToken('!FFCCEE11')).toBe('@!ffccee11 ');
  });

  it('reads tokens of either case, since Android emits uppercase too', () => {
    expect(mentionedNodeIds('@!FFCCEE11 and @!00a1b2c3 please')).toEqual(['!ffccee11', '!00a1b2c3']);
  });

  it('does not read a longer hex run as a mention', () => {
    expect(mentionedNodeIds('@!deadbeef00')).toEqual([]);
    expect(mentionedNodeIds('@!deadbee')).toEqual([]);
  });

  it('lists each mentioned node once, in order', () => {
    expect(mentionedNodeIds('@!deadbeef @!ffccee11 @!deadbeef')).toEqual(['!deadbeef', '!ffccee11']);
  });

  it('matches a self-mention by id alone, folding case', () => {
    expect(textMentionsNode('ping @!FFCCEE11', '!ffccee11')).toBe(true);
    expect(textMentionsNode('ping @!ffccee11', '!00a1b2c3')).toBe(false);
    // Names are never matched against text: that is what keeps it exact.
    expect(textMentionsNode('ping @EOC Operator', '!ffccee11')).toBe(false);
    expect(textMentionsNode('ping @!ffccee11', null)).toBe(false);
  });
});

describe('findMentionQuery (#5276)', () => {
  it('opens on a bare @ at the start of a word', () => {
    expect(findMentionQuery('@', 1)).toEqual({ query: '', start: 0, end: 1 });
    expect(findMentionQuery('hey @', 5)).toEqual({ query: '', start: 4, end: 5 });
  });

  it('carries the typed query, lowercased', () => {
    expect(findMentionQuery('hey @EO', 7)).toEqual({ query: 'eo', start: 4, end: 7 });
  });

  it('does not open inside a word, so an email is left alone', () => {
    expect(findMentionQuery('mail me@host', 12)).toBeNull();
  });

  it('closes once the query contains whitespace', () => {
    expect(findMentionQuery('@EOC Operator can you', 21)).toBeNull();
  });

  it('does not re-trigger on an already resolved token', () => {
    expect(findMentionQuery('@!ffccee11', 10)).toBeNull();
  });

  it('only considers the @ left of the caret', () => {
    // Caret sits right after "@Fi"; the later @ must not be picked up.
    expect(findMentionQuery('@Fi and @EOC', 3)).toEqual({ query: 'fi', start: 0, end: 3 });
  });
});

describe('filterMentionCandidates (#5276)', () => {
  it('matches long name, short name and id', () => {
    expect(filterMentionCandidates(NODES, 'eoc').map(n => n.id)).toEqual(['!ffccee11']);
    expect(filterMentionCandidates(NODES, 'fne').map(n => n.id)).toEqual(['!00a1b2c3']);
    expect(filterMentionCandidates(NODES, 'dead').map(n => n.id)).toEqual(['!deadbeef']);
  });

  it('offers everything for a bare @, up to the limit', () => {
    expect(filterMentionCandidates(NODES, '')).toHaveLength(3);
    expect(filterMentionCandidates(NODES, '', 2)).toHaveLength(2);
  });

  it('returns nothing when no node matches', () => {
    expect(filterMentionCandidates(NODES, 'zzz')).toEqual([]);
  });
});

describe('applyMention (#5276)', () => {
  it('replaces the typed query with the token and puts the caret after it', () => {
    // The token's own trailing space replaces the one already there, so the
    // message recipients see has no double space.
    const text = 'hey @EO can you check';
    const query = findMentionQuery(text, 7)!;
    expect(applyMention(text, query, '!ffccee11')).toEqual({
      text: 'hey @!ffccee11 can you check',
      caret: 15,
    });
  });

  it('keeps other following punctuation as typed', () => {
    const text = 'ask @EO?';
    const query = findMentionQuery(text, 7)!;
    expect(applyMention(text, query, '!ffccee11').text).toBe('ask @!ffccee11 ?');
  });

  it('works on a bare @ at the end of the draft', () => {
    const text = 'ping @';
    const query = findMentionQuery(text, 6)!;
    expect(applyMention(text, query, '!deadbeef')).toEqual({ text: 'ping @!deadbeef ', caret: 16 });
  });
});
