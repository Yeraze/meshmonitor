<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'

const { frontmatter, page, site } = useData()

const isBlogPost = computed(() => {
  const rel = page.value.relativePath || ''
  if (!rel.startsWith('blog/')) return false
  if (rel === 'blog/index.md' || rel === 'blog/') return false
  return true
})

const title = computed(() => frontmatter.value.title || '')

const formattedDate = computed(() => {
  const raw = frontmatter.value.date
  if (!raw) return ''
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
})

const isoDate = computed(() => {
  const raw = frontmatter.value.date
  if (!raw) return ''
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
})

const category = computed(() => frontmatter.value.category as string | undefined)
const priority = computed(() => {
  const p = frontmatter.value.priority as string | undefined
  return p && p !== 'normal' ? p : undefined
})

const tags = computed<string[]>(() => {
  const t = frontmatter.value.tags
  if (Array.isArray(t)) return t.filter(Boolean).map(String)
  if (typeof t === 'string' && t.trim()) {
    return t.split(',').map((s) => s.trim()).filter(Boolean)
  }
  return []
})

const base = computed(() => site.value.base || '/')

const blogHref = computed(() => `${base.value}blog/`.replace(/\/+/g, '/'))
const homeHref = computed(() => base.value)
</script>

<template>
  <div v-if="isBlogPost" class="blog-post-header">
    <nav class="blog-breadcrumbs" aria-label="Breadcrumb">
      <a :href="homeHref">Home</a>
      <span class="sep" aria-hidden="true">›</span>
      <a :href="blogHref">Blog</a>
      <span class="sep" aria-hidden="true">›</span>
      <span class="current" :title="title">{{ title }}</span>
    </nav>

    <h1 v-if="title" class="blog-post-title">{{ title }}</h1>

    <div class="blog-post-meta">
      <time v-if="formattedDate" :datetime="isoDate">{{ formattedDate }}</time>

      <span v-if="category" :class="['badge', 'badge-' + category]">{{ category }}</span>
      <span
        v-if="priority"
        :class="['badge', 'badge-priority-' + priority]"
      >{{ priority }}</span>

      <span
        v-for="tag in tags"
        :key="tag"
        class="badge badge-tag"
      >{{ tag }}</span>
    </div>
  </div>
</template>

<style scoped>
.blog-post-header {
  margin: 0 0 1.75rem;
  padding-bottom: 1.25rem;
  border-bottom: 1px solid var(--vp-c-divider);
}

.blog-breadcrumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: var(--vp-c-text-2);
  margin-bottom: 0.85rem;
}
.blog-breadcrumbs a {
  color: var(--vp-c-text-2);
  text-decoration: none;
  transition: color 0.15s ease;
}
.blog-breadcrumbs a:hover {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}
.blog-breadcrumbs .sep {
  color: var(--vp-c-text-3);
}
.blog-breadcrumbs .current {
  color: var(--vp-c-text-1);
  font-weight: 500;
  max-width: 32ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.blog-post-title {
  margin: 0 0 0.75rem;
  font-size: clamp(1.6rem, 2.4vw, 2.25rem);
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
  border-bottom: none;
  padding: 0;
}

.blog-post-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.55rem;
  font-size: 0.85rem;
  color: var(--vp-c-text-2);
}

.blog-post-meta time {
  font-variant-numeric: tabular-nums;
}

.badge {
  display: inline-block;
  padding: 0.1rem 0.55rem;
  border-radius: 0.3rem;
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-1);
  line-height: 1.4;
}
.badge-security { background: var(--vp-c-danger-soft); color: var(--vp-c-danger-1); }
.badge-release { background: var(--vp-c-brand-soft); color: var(--vp-c-brand-1); }
.badge-feature { background: var(--vp-c-tip-soft); color: var(--vp-c-tip-1); }
.badge-maintenance,
.badge-bugfix { background: var(--vp-c-warning-soft); color: var(--vp-c-warning-1); }
.badge-guide { background: var(--vp-c-purple-soft); color: var(--vp-c-purple-1); }
.badge-priority-critical { background: var(--vp-c-danger-soft); color: var(--vp-c-danger-1); }
.badge-priority-important { background: var(--vp-c-warning-soft); color: var(--vp-c-warning-1); }
.badge-tag {
  text-transform: none;
  letter-spacing: 0;
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-2);
  font-weight: 500;
}
</style>
