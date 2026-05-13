---
title: Blog
aside: false
---

# Blog

News, releases, security advisories, and feature announcements for MeshMonitor.

<script setup>
import { computed } from 'vue';
import { data as posts } from './posts.data.ts';

const featured = computed(() => posts.slice(0, 3));
const archive = computed(() => posts.slice(3));

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
</script>

<section v-if="featured.length" class="blog-featured">
  <article
    v-for="post in featured"
    :key="post.url"
    :class="['blog-card', post.category ? 'category-' + post.category : '']"
  >
    <header class="blog-card-meta">
      <time :datetime="post.date">{{ fmtDate(post.date) }}</time>
      <span v-if="post.category" :class="['badge', 'badge-' + post.category]">{{ post.category }}</span>
      <span v-if="post.priority && post.priority !== 'normal'" :class="['badge', 'badge-priority-' + post.priority]">{{ post.priority }}</span>
    </header>
    <a :href="post.url" class="blog-card-title">{{ post.title }}</a>
    <p v-if="post.excerpt" class="blog-card-excerpt">{{ post.excerpt }}</p>
    <a :href="post.url" class="blog-card-readmore">Read more →</a>
  </article>
</section>

<h2 v-if="archive.length" class="blog-archive-heading">Earlier Posts</h2>

<ul v-if="archive.length" class="blog-list">
  <li v-for="post in archive" :key="post.url" class="blog-item">
    <div class="blog-meta">
      <time :datetime="post.date">{{ fmtDate(post.date) }}</time>
      <span v-if="post.category" :class="['badge', 'badge-' + post.category]">{{ post.category }}</span>
      <span v-if="post.priority && post.priority !== 'normal'" :class="['badge', 'badge-priority-' + post.priority]">{{ post.priority }}</span>
    </div>
    <a :href="post.url" class="blog-title">{{ post.title }}</a>
  </li>
</ul>

<style scoped>
.blog-featured {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1.25rem;
  margin: 2rem 0 1rem;
}

@media (max-width: 960px) {
  .blog-featured { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .blog-featured { grid-template-columns: 1fr; }
}

.blog-card {
  display: flex;
  flex-direction: column;
  padding: 1.1rem 1.2rem 1.2rem;
  border: 1px solid var(--vp-c-divider);
  border-top: 3px solid var(--vp-c-default-3);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
}
.blog-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  border-color: var(--vp-c-brand-1);
}
.blog-card.category-security { border-top-color: var(--vp-c-danger-1); }
.blog-card.category-release { border-top-color: var(--vp-c-brand-1); }
.blog-card.category-feature { border-top-color: var(--vp-c-tip-1); }
.blog-card.category-maintenance,
.blog-card.category-bugfix { border-top-color: var(--vp-c-warning-1); }

.blog-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  font-size: 0.78rem;
  color: var(--vp-c-text-2);
  margin-bottom: 0.6rem;
}

.blog-card-title {
  font-size: 1.1rem;
  font-weight: 700;
  line-height: 1.3;
  text-decoration: none;
  color: var(--vp-c-text-1);
  margin-bottom: 0.65rem;
}
.blog-card-title:hover { color: var(--vp-c-brand-1); }

.blog-card-excerpt {
  font-size: 0.9rem;
  line-height: 1.5;
  color: var(--vp-c-text-2);
  flex: 1;
  margin: 0 0 0.9rem;
}

.blog-card-readmore {
  font-size: 0.85rem;
  font-weight: 600;
  text-decoration: none;
  color: var(--vp-c-brand-1);
  align-self: flex-start;
}
.blog-card-readmore:hover { text-decoration: underline; }

.blog-archive-heading {
  margin-top: 2.5rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.blog-list {
  list-style: none;
  padding: 0;
  margin: 1rem 0 0;
}
.blog-item {
  padding: 0.9rem 0;
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
  font-size: 1.05rem;
  font-weight: 600;
  text-decoration: none;
  color: var(--vp-c-brand-1);
}
.blog-title:hover { text-decoration: underline; }

.badge {
  display: inline-block;
  padding: 0.05rem 0.5rem;
  border-radius: 0.25rem;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-1);
}
.badge-security { background: var(--vp-c-danger-soft); color: var(--vp-c-danger-1); }
.badge-release { background: var(--vp-c-brand-soft); color: var(--vp-c-brand-1); }
.badge-feature { background: var(--vp-c-tip-soft); color: var(--vp-c-tip-1); }
.badge-maintenance,
.badge-bugfix { background: var(--vp-c-warning-soft); color: var(--vp-c-warning-1); }
.badge-priority-critical { background: var(--vp-c-danger-soft); color: var(--vp-c-danger-1); }
.badge-priority-important { background: var(--vp-c-warning-soft); color: var(--vp-c-warning-1); }
</style>
