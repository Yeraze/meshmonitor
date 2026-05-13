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

export default createContentLoader('blog/*.md', {
  excerpt: false,
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
      }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  },
});
