/**
 * Shows a Meshtastic trigger pattern with its literal text and `{param}`
 * placeholders in the legend's two colours. Several comma-separated patterns
 * show as `[a, b]`.
 *
 * Replaces three hand-copied renderers (the TriggerItem row, the add form's
 * preview and the quick test) when they merged into the TriggerCard (#5808).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { splitTriggerPatterns } from './utils';
import styles from './PatternHighlight.module.css';

interface Segment {
  text: string;
  type: 'literal' | 'parameter';
  paramName?: string;
  start: number;
  end: number;
}

function segmentsOf(pattern: string): Segment[][] {
  const segments: Segment[] = [];
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '{') {
      let depth = 1;
      let end = i + 1;
      while (end < pattern.length && depth > 0) {
        if (pattern[end] === '{') depth++;
        else if (pattern[end] === '}') depth--;
        end++;
      }
      const inner = pattern.substring(i + 1, end - 1);
      const colon = inner.indexOf(':');
      segments.push({
        text: pattern.substring(i, end),
        type: 'parameter',
        paramName: colon >= 0 ? inner.substring(0, colon) : inner,
        start: i,
        end,
      });
      i = end;
    } else {
      const start = i;
      while (i < pattern.length && pattern[i] !== '{') i++;
      const text = pattern.substring(start, i);
      if (text.trim()) segments.push({ text, type: 'literal', start, end: i });
    }
  }

  // Segments that touch with no space between them read as one word.
  const groups: Segment[][] = [];
  let group: Segment[] = [];
  segments.forEach((seg, j) => {
    group.push(seg);
    const next = segments[j + 1];
    const joined = !!next
      && next.start === seg.end
      && !(seg.type === 'literal' && seg.text.endsWith(' '))
      && !(next.type === 'literal' && next.text.startsWith(' '));
    if (!joined) {
      groups.push(group);
      group = [];
    }
  });
  return groups;
}

interface PatternHighlightProps {
  trigger: string | string[];
}

const PatternHighlight: React.FC<PatternHighlightProps> = ({ trigger }) => {
  const { t } = useTranslation();
  const patterns = splitTriggerPatterns(trigger);
  const multi = patterns.length > 1;

  const segment = (seg: Segment, key: React.Key) => (
    <span
      key={key}
      className={seg.type === 'parameter' ? styles.parameter : styles.literal}
      title={seg.type === 'parameter' ? t('auto_responder.parameter_title', { name: seg.paramName }) : t('auto_responder.literal_text')}
    >
      {seg.type === 'literal' ? seg.text.trim() : seg.text}
    </span>
  );

  return (
    <span className={styles.root}>
      {multi && <span className={styles.bracket}>[</span>}
      {patterns.map((pattern, pi) => (
        <React.Fragment key={pi}>
          <span className={styles.pattern}>
            {segmentsOf(pattern).map((group, gi) =>
              group.length === 1
                ? segment(group[0], gi)
                : <span key={gi} className={styles.joined}>{group.map((s, si) => segment(s, si))}</span>,
            )}
          </span>
          {pi < patterns.length - 1 && <span className={styles.bracket}>,</span>}
        </React.Fragment>
      ))}
      {multi && <span className={styles.bracket}>]</span>}
    </span>
  );
};

export default PatternHighlight;
