---
title: Blog
aside: false
---

# Blog

News, releases, security advisories, and feature announcements for MeshMonitor.

<script setup>
import { data as posts } from './posts.data.ts';

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
</script>

<ul class="blog-list">
  <li v-for="post in posts" :key="post.url" class="blog-item">
    <div class="blog-meta">
      <time :datetime="post.date">{{ fmtDate(post.date) }}</time>
      <span v-if="post.category" :class="['badge', 'badge-' + post.category]">{{ post.category }}</span>
      <span v-if="post.priority && post.priority !== 'normal'" :class="['badge', 'badge-priority-' + post.priority]">{{ post.priority }}</span>
    </div>
    <a :href="post.url" class="blog-title">{{ post.title }}</a>
  </li>
</ul>

<style scoped>
.blog-list {
  list-style: none;
  padding: 0;
  margin: 1.5rem 0 0;
}
.blog-item {
  padding: 1rem 0;
  border-bottom: 1px solid var(--vp-c-divider);
}
.blog-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  font-size: 0.85rem;
  color: var(--vp-c-text-2);
  margin-bottom: 0.25rem;
}
.blog-title {
  font-size: 1.1rem;
  font-weight: 600;
  text-decoration: none;
  color: var(--vp-c-brand-1);
}
.blog-title:hover {
  text-decoration: underline;
}
.badge {
  display: inline-block;
  padding: 0.05rem 0.5rem;
  border-radius: 0.25rem;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-1);
}
.badge-security { background: var(--vp-c-danger-soft); color: var(--vp-c-danger-1); }
.badge-release { background: var(--vp-c-brand-soft); color: var(--vp-c-brand-1); }
.badge-feature { background: var(--vp-c-tip-soft); color: var(--vp-c-tip-1); }
.badge-maintenance { background: var(--vp-c-warning-soft); color: var(--vp-c-warning-1); }
.badge-bugfix { background: var(--vp-c-warning-soft); color: var(--vp-c-warning-1); }
.badge-priority-critical { background: var(--vp-c-danger-soft); color: var(--vp-c-danger-1); }
.badge-priority-important { background: var(--vp-c-warning-soft); color: var(--vp-c-warning-1); }
</style>
