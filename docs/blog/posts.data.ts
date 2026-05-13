import { createContentLoader } from 'vitepress';

export interface BlogPost {
  url: string;
  title: string;
  date: string;
  category?: string;
  priority?: string;
  minVersion?: string;
  excerpt?: string;
}

declare const data: BlogPost[];
export { data };

function makeExcerpt(src: string, maxLen = 220): string {
  if (!src) return '';
  const body = src.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const paragraphs = body.split(/\n\s*\n/);
  let para = '';
  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('```')) continue;
    if (trimmed.startsWith('>')) continue;
    para = trimmed;
    break;
  }
  let text = para
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)_([^_]+)_/g, '$1$2')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > maxLen) {
    text = text.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
  }
  return text;
}

export default createContentLoader('blog/*.md', {
  includeSrc: true,
  transform(raw): BlogPost[] {
    return raw
      .filter((page) => !page.url.endsWith('/blog/'))
      .map((page) => ({
        url: page.url,
        title: page.frontmatter.title ?? '',
        date: typeof page.frontmatter.date === 'string'
          ? page.frontmatter.date
          : new Date(page.frontmatter.date).toISOString(),
        category: page.frontmatter.category,
        priority: page.frontmatter.priority,
        minVersion: page.frontmatter.minVersion,
        excerpt: makeExcerpt(page.src ?? ''),
      }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  },
});
