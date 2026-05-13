#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const blogDir = join(repoRoot, 'docs/blog');
const newsJsonPath = join(repoRoot, 'docs/public/news.json');

function toIsoString(value) {
  if (value instanceof Date) return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return String(value);
}

function loadPosts() {
  const entries = readdirSync(blogDir, { withFileTypes: true });
  const posts = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith('.md')) continue;
    if (e.name === 'index.md') continue;
    const filePath = join(blogDir, e.name);
    const raw = readFileSync(filePath, 'utf8');
    const parsed = matter(raw);
    const fm = parsed.data;
    if (!fm.id || !fm.title || !fm.date) {
      throw new Error(`${basename(filePath)}: frontmatter missing required id/title/date`);
    }
    const content = parsed.content.replace(/^\n+/, '').replace(/\s+$/, '');
    const item = {};
    if (fm.minVersion !== undefined) item.minVersion = String(fm.minVersion);
    item.id = String(fm.id);
    item.title = String(fm.title);
    item.content = content;
    item.date = toIsoString(fm.date);
    item.category = String(fm.category);
    item.priority = String(fm.priority);
    posts.push(item);
  }
  return posts;
}

function build() {
  const items = loadPosts();
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const lastUpdated = items.length ? items[0].date : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const feed = {
    version: '1',
    lastUpdated,
    items,
  };
  mkdirSync(dirname(newsJsonPath), { recursive: true });
  writeFileSync(newsJsonPath, JSON.stringify(feed, null, 2) + '\n', 'utf8');
  return { count: items.length, lastUpdated };
}

const { count, lastUpdated } = build();
console.log(`wrote ${newsJsonPath} — ${count} item(s), lastUpdated=${lastUpdated}`);
