import type { McoImageV4Document, V4Figure } from './model.js';

function collect(figures: readonly V4Figure[], out: string[]): void {
  for (const figure of figures) {
    if (figure.kind === 'group') {
      collect(figure.figures, out);
    } else if (figure.kind === 'text') {
      const text = figure.text.replace(/\n/g, ' ').trim();
      if (text !== '' && out[out.length - 1] !== text) out.push(text);
    }
  }
}

/** Text figures in paint order, groups recursed; newlines become spaces; empties and runs of repeats dropped. */
export function collectV4Captions(doc: McoImageV4Document): string[] {
  const out: string[] = [];
  collect(doc.figures, out);
  return out;
}
