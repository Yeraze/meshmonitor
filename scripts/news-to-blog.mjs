#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const newsJsonPath = join(repoRoot, 'docs/public/news.json');
const blogDir = join(repoRoot, 'docs/blog');

function slugFromTitle(title) {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function slugFromId(id) {
  // id pattern: news-YYYY-MM-DD-rest
  const m = id.match(/^news-\d{4}-\d{2}-\d{2}-(.+)$/);
  return m ? m[1] : null;
}

function pad(n) { return String(n).padStart(2, '0'); }

function dateOnly(iso) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const feed = JSON.parse(readFileSync(newsJsonPath, 'utf8'));

mkdirSync(blogDir, { recursive: true });

const seen = new Set();
let created = 0;
for (const item of feed.items) {
  const datePart = dateOnly(item.date);
  const slug = slugFromId(item.id) || slugFromTitle(item.title);
  let filename = `${datePart}-${slug}.md`;
  let i = 2;
  while (seen.has(filename)) {
    filename = `${datePart}-${slug}-${i}.md`;
    i++;
  }
  seen.add(filename);

  const frontmatter = {
    id: item.id,
    title: item.title,
    date: item.date,
    category: item.category,
    priority: item.priority,
  };
  if (item.minVersion !== undefined) frontmatter.minVersion = item.minVersion;

  const body = item.content ?? '';
  const fileContent = matter.stringify(body.endsWith('\n') ? body : body + '\n', frontmatter);
  const outPath = join(blogDir, filename);
  writeFileSync(outPath, fileContent, 'utf8');
  created++;
  console.log(`wrote ${filename}`);
}

console.log(`\ncreated ${created} blog post(s) in ${blogDir}`);
