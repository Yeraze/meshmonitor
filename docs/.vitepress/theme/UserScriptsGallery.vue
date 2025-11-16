<template>
  <div class="user-scripts-gallery">
    <!-- Docs Mode: CTA Only -->
    <div class="docs-view">
      <div class="view-scripts-cta">
        <h3 class="cta-title">Browse User Scripts</h3>
        <p class="cta-description">
          Explore our collection of community-contributed Auto Responder scripts. 
          Find scripts for weather, system info, greetings, and more. Each script 
          includes detailed documentation, code examples, and setup instructions.
        </p>
        <button class="cta-button" @click="showScriptsModal = true">
          📜 Browse All Scripts
          <span class="cta-arrow">→</span>
        </button>
      </div>
    </div>

    <!-- Full-Screen Scripts Modal -->
    <Transition name="modal">
      <div v-if="showScriptsModal" class="scripts-modal-overlay" @click.self="showScriptsModal = false">
        <div class="scripts-modal-content">
          <div class="scripts-modal-header">
            <h2>User Scripts Gallery</h2>
            <button class="close-modal-btn" @click="showScriptsModal = false" title="Return to Docs">
              ← Return to Docs <span class="close-x">×</span>
            </button>
          </div>

          <div class="scripts-modal-body">

        <div class="two-column-layout">
          <!-- Left Sidebar -->
          <aside class="sidebar">
            <div class="sidebar-section">
              <label for="search-input">Search Scripts</label>
              <input
                id="search-input"
                v-model="searchQuery"
                type="text"
                placeholder="Search by name, description, author..."
                class="search-input"
              />
            </div>

            <div class="sidebar-section">
              <label>Language</label>
              <div class="filter-buttons-vertical">
                <button
                  v-for="lang in languages"
                  :key="lang"
                  :class="['filter-btn', { active: selectedLanguage === lang }]"
                  @click="toggleLanguage(lang)"
                >
                  {{ lang }}
                </button>
              </div>
            </div>

            <div class="sidebar-section">
              <label>Tags</label>
              <div class="filter-buttons-vertical">
                <button
                  v-for="tag in allTags"
                  :key="tag"
                  :class="['filter-btn', 'tag-btn', { active: selectedTags.includes(tag) }]"
                  @click="toggleTag(tag)"
                >
                  {{ tag }}
                </button>
              </div>
            </div>

            <div class="sidebar-section" v-if="selectedLanguage || selectedTags.length > 0 || searchQuery">
              <button class="clear-btn" @click="clearAllFilters">Clear All</button>
            </div>

            <div class="sidebar-section results-count">
              <p class="count-text">
                Showing <strong>{{ paginatedScripts.length }}</strong> of <strong>{{ searchedAndFilteredScripts.length }}</strong> scripts
              </p>
            </div>
          </aside>

          <!-- Right Main Area -->
          <main class="main-content">
            <div class="scripts-grid-compact">
              <div
                v-for="script in paginatedScripts"
                :key="script.filename"
                class="script-card-compact"
              >
                <div class="card-header-compact">
                  <div class="header-left">
                    <h3 class="script-name-compact">
                      <span v-if="script.icon" class="script-icon">{{ script.icon }}</span>
                      {{ script.name }}
                    </h3>
                    <span class="script-author">by {{ script.author }}</span>
                  </div>
                  <span :class="['language-badge', `lang-${script.language.toLowerCase()}`]">
                    {{ script.language }}
                  </span>
                </div>
                
                <p class="script-description-compact">{{ script.description }}</p>
                
                <div class="script-tags-compact">
                  <span
                    v-for="tag in script.tags"
                    :key="tag"
                    class="tag-chip"
                  >
                    {{ tag }}
                  </span>
                </div>

                <div class="card-actions-compact">
                  <button
                    class="action-btn-compact view-details"
                    @click="openModal(script)"
                  >
                    📋 View Details
                  </button>
                </div>
              </div>
            </div>

            <div v-if="paginatedScripts.length === 0" class="no-results">
              <div class="no-results-icon">🔍</div>
              <h3 class="no-results-title">No scripts found</h3>
              <p class="no-results-message">Try adjusting your search or filters to find what you're looking for.</p>
            </div>

            <!-- Pagination -->
            <div v-if="searchedAndFilteredScripts.length > 0" class="pagination">
              <div class="pagination-info">
                <span>
                  Page {{ currentPage }} of {{ totalPages }}
                  ({{ startIndex + 1 }}-{{ endIndex }} of {{ searchedAndFilteredScripts.length }})
                </span>
                <select v-model="itemsPerPage" class="items-per-page">
                  <option :value="6">6 per page</option>
                  <option :value="9">9 per page</option>
                  <option :value="12">12 per page</option>
                  <option :value="18">18 per page</option>
                </select>
              </div>
              <div class="pagination-controls">
                <button
                  class="page-btn"
                  @click="goToPage(currentPage - 1)"
                  :disabled="currentPage === 1"
                >
                  ← Previous
                </button>
                <div class="page-numbers">
                  <button
                    v-for="page in visiblePages"
                    :key="page"
                    :class="['page-number', { active: page === currentPage }]"
                    @click="goToPage(page)"
                  >
                    {{ page }}
                  </button>
                </div>
                <button
                  class="page-btn"
                  @click="goToPage(currentPage + 1)"
                  :disabled="currentPage === totalPages"
                >
                  Next →
                </button>
              </div>
            </div>
          </main>
        </div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- Script Details Modal -->
    <Transition name="modal">
      <div v-if="selectedScript" class="modal-overlay" @click="closeModal">
        <div class="modal-content" @click.stop>
          <div class="modal-header">
            <div class="modal-header-left">
              <h2 class="modal-title">
                <span v-if="selectedScript.icon" class="script-icon">{{ selectedScript.icon }}</span>
                {{ selectedScript.name }}
              </h2>
              <span :class="['language-badge', `lang-${selectedScript.language.toLowerCase()}`]">
                {{ selectedScript.language }}
              </span>
            </div>
            <button class="modal-close" @click="closeModal">×</button>
          </div>

          <div class="modal-body">
            <div class="modal-two-column">
              <!-- Left: Details -->
              <div class="modal-details-column">
                <div class="detail-section">
                  <h3>Description</h3>
                  <p>{{ selectedScript.description }}</p>
                </div>

                <div class="detail-section">
                  <h3>Author</h3>
                  <p>{{ selectedScript.author }}</p>
                </div>

                <div class="detail-section" v-if="selectedScript.exampleTrigger">
                  <h3>Example Trigger</h3>
                  <code class="trigger-code-large">{{ selectedScript.exampleTrigger }}</code>
                </div>

                <div class="detail-section" v-if="selectedScript.requirements && (Array.isArray(selectedScript.requirements) ? selectedScript.requirements.length > 0 : selectedScript.requirements)">
                  <h3>Requirements</h3>
                  <ul v-if="Array.isArray(selectedScript.requirements)" class="requirements-list">
                    <li v-for="req in selectedScript.requirements" :key="req">{{ req }}</li>
                  </ul>
                  <p v-else>{{ selectedScript.requirements }}</p>
                </div>

                <div class="detail-section" v-if="selectedScript.features && selectedScript.features.length > 0">
                  <h3>Features</h3>
                  <ul class="features-list-large">
                    <li v-for="feature in selectedScript.features" :key="feature">{{ feature }}</li>
                  </ul>
                </div>

                <div class="detail-section">
                  <h3>Tags</h3>
                  <div class="script-tags">
                    <span
                      v-for="tag in selectedScript.tags"
                      :key="tag"
                      class="tag-chip"
                    >
                      {{ tag }}
                    </span>
                  </div>
                </div>
              </div>

              <!-- Right: Code Viewer -->
              <div class="modal-code-column">
                <div class="code-viewer-header">
                  <span class="code-filename">{{ selectedScript.filename }}</span>
                  <div class="code-header-actions">
                    <button
                      class="copy-code-btn"
                      @click="copyScriptCode(selectedScript)"
                      :disabled="loadingCode"
                    >
                      {{ loadingCode ? 'Loading...' : (codeCopied ? '✓ Copied!' : '📋 Copy Script') }}
                    </button>
                    <button
                      class="download-code-btn"
                      @click="downloadScript(selectedScript)"
                      :disabled="loadingCode || !scriptCode"
                      title="Download script file"
                    >
                      💾 Download
                    </button>
                  </div>
                </div>
                <div class="code-viewer">
                  <div v-if="loadingCode" class="code-loading-skeleton">
                    <div class="skeleton-line" v-for="n in 15" :key="n" :style="{ width: n % 3 === 0 ? '90%' : n % 3 === 1 ? '75%' : '100%' }"></div>
                  </div>
                  <pre v-else-if="codeError" class="code-error">
                    <div class="code-error-icon">⚠️</div>
                    <div class="code-error-message">{{ codeError }}</div>
                  </pre>
                  <pre v-else ref="codeElement" class="code-block"><code :class="`language-${getLanguageAlias(selectedScript.language)}`" class="code-content">{{ scriptCode }}</code></pre>
                </div>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <button
              class="modal-btn copy-script-btn"
              @click="copyScript(selectedScript, $event)"
            >
              📋 Copy Script
            </button>
            <a
              :href="getSourceUrl(selectedScript)"
              target="_blank"
              rel="noopener noreferrer"
              class="modal-btn view-github-btn"
            >
              📄 View Source
            </a>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted, onMounted, nextTick } from 'vue'
import scriptsData from '../data/user-scripts.json'
import { validateGitHubPath } from '../utils/githubUrlValidation'

const scripts = ref(scriptsData)
const showScriptsModal = ref(false)
const selectedLanguage = ref(null)
const selectedTags = ref([])
const searchQuery = ref('')
const currentPage = ref(1)
const itemsPerPage = ref(9)
const selectedScript = ref(null)
const scriptCode = ref('')
const loadingCode = ref(false)
const codeError = ref(null)
const codeCopied = ref(false)
const codeElement = ref(null)

// Prevent body scroll when modal is open
watch(showScriptsModal, (isOpen) => {
  if (isOpen) {
    document.body.style.overflow = 'hidden'
  } else {
    document.body.style.overflow = ''
  }
})

onUnmounted(() => {
  document.body.style.overflow = ''
})

// Extract unique languages and tags
const languages = computed(() => {
  const langs = new Set(scripts.value.map(s => s.language))
  return Array.from(langs).sort()
})

// Get tags from currently filtered scripts (respects search and language filters)
const allTags = computed(() => {
  // First apply search and language filters to get visible scripts
  let filteredScripts = scripts.value
  
  // Apply search filter
  if (searchQuery.value.trim()) {
    // Security: Sanitize search query
    const sanitizedQuery = sanitizeSearchQuery(searchQuery.value)
    const query = sanitizedQuery.toLowerCase()
    filteredScripts = filteredScripts.filter(script => {
      return (
        script.name.toLowerCase().includes(query) ||
        script.description.toLowerCase().includes(query) ||
        script.author.toLowerCase().includes(query) ||
        script.filename.toLowerCase().includes(query) ||
        script.tags.some(tag => tag.toLowerCase().includes(query))
      )
    })
  }
  
  // Apply language filter
  if (selectedLanguage.value) {
    filteredScripts = filteredScripts.filter(script => script.language === selectedLanguage.value)
  }
  
  // Extract unique tags from filtered scripts
  const tags = new Set()
  filteredScripts.forEach(script => {
    if (script.tags && Array.isArray(script.tags)) {
      script.tags.forEach(tag => tags.add(tag))
    }
  })
  return Array.from(tags).sort()
})

// Security: Sanitize search input to prevent ReDoS and DoS
const sanitizeSearchQuery = (query) => {
  if (!query || typeof query !== 'string') {
    return ''
  }
  
  // Remove null bytes and control characters
  let sanitized = query.replace(/[\x00-\x1F\x7F]/g, '')
  
  // Limit length to prevent DoS (100 chars max)
  const MAX_SEARCH_LENGTH = 100
  if (sanitized.length > MAX_SEARCH_LENGTH) {
    sanitized = sanitized.substring(0, MAX_SEARCH_LENGTH)
  }
  
  return sanitized.trim()
}

// Search and filter scripts
const searchedAndFilteredScripts = computed(() => {
  let result = scripts.value

  // Search filter
  if (searchQuery.value.trim()) {
    // Security: Sanitize search query
    const sanitizedQuery = sanitizeSearchQuery(searchQuery.value)
    const query = sanitizedQuery.toLowerCase()
    result = result.filter(script => {
      return (
        script.name.toLowerCase().includes(query) ||
        script.description.toLowerCase().includes(query) ||
        script.author.toLowerCase().includes(query) ||
        script.filename.toLowerCase().includes(query) ||
        script.tags.some(tag => tag.toLowerCase().includes(query))
      )
    })
  }

  // Language filter
  if (selectedLanguage.value) {
    result = result.filter(script => script.language === selectedLanguage.value)
  }

  // Tag filter
  if (selectedTags.value.length > 0) {
    result = result.filter(script => {
      return selectedTags.value.some(tag => script.tags.includes(tag))
    })
  }

  return result
})

// For docs mode (no pagination)
const filteredScripts = computed(() => {
  return searchedAndFilteredScripts.value
})

// Pagination
const totalPages = computed(() => {
  return Math.ceil(searchedAndFilteredScripts.value.length / itemsPerPage.value)
})

const startIndex = computed(() => {
  return (currentPage.value - 1) * itemsPerPage.value
})

const endIndex = computed(() => {
  return Math.min(startIndex.value + itemsPerPage.value, searchedAndFilteredScripts.value.length)
})

const paginatedScripts = computed(() => {
  return searchedAndFilteredScripts.value.slice(startIndex.value, endIndex.value)
})

const visiblePages = computed(() => {
  const pages = []
  const total = totalPages.value
  const current = currentPage.value
  
  if (total <= 7) {
    for (let i = 1; i <= total; i++) {
      pages.push(i)
    }
  } else {
    if (current <= 3) {
      for (let i = 1; i <= 5; i++) pages.push(i)
      pages.push('...')
      pages.push(total)
    } else if (current >= total - 2) {
      pages.push(1)
      pages.push('...')
      for (let i = total - 4; i <= total; i++) pages.push(i)
    } else {
      pages.push(1)
      pages.push('...')
      for (let i = current - 1; i <= current + 1; i++) pages.push(i)
      pages.push('...')
      pages.push(total)
    }
  }
  
  return pages
})

// Watch for filter changes and reset to page 1
watch([searchQuery, selectedLanguage, selectedTags], () => {
  currentPage.value = 1
})

watch(itemsPerPage, () => {
  currentPage.value = 1
})

const toggleLanguage = (lang) => {
  selectedLanguage.value = selectedLanguage.value === lang ? null : lang
}

const toggleTag = (tag) => {
  const index = selectedTags.value.indexOf(tag)
  if (index > -1) {
    selectedTags.value.splice(index, 1)
  } else {
    selectedTags.value.push(tag)
  }
}

const clearFilters = () => {
  selectedLanguage.value = null
  selectedTags.value = []
}

const clearAllFilters = () => {
  selectedLanguage.value = null
  selectedTags.value = []
  searchQuery.value = ''
}

const goToPage = (page) => {
  if (page >= 1 && page <= totalPages.value && page !== '...') {
    currentPage.value = page
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

// Modal functions
const openModal = async (script) => {
  selectedScript.value = script
  scriptCode.value = ''
  codeError.value = null
  codeCopied.value = false
  // Auto-load code when opening modal
  await fetchScriptCode(script)
}

const closeModal = () => {
  selectedScript.value = null
  scriptCode.value = ''
  codeError.value = null
  codeCopied.value = false
}

// Get language alias for Prism
const getLanguageAlias = (language) => {
  const aliases = {
    'Python': 'python',
    'JavaScript': 'javascript',
    'TypeScript': 'typescript',
    'Shell': 'bash',
    'Bash': 'bash',
    'sh': 'bash'
  }
  return aliases[language] || language.toLowerCase()
}

/**
 * Get source URL for viewing a script on GitHub
 * Supports both main repo (examples/) and external user repos
 * 
 * Path formats:
 * - Main repo: "examples/auto-responder-scripts/script.py"
 * - External repo: "USERNAME/repo/branch/path/to/script.py" or "USERNAME/repo/path/to/script.py" (defaults to main branch)
 * 
 * @param {Object} script - Script object with githubPath property
 * @returns {string} GitHub URL for viewing the file
 */
const getSourceUrl = (script) => {
  if (!script.githubPath) return '#'
  
  // If path starts with "examples/", it's in the main meshmonitor repo
  if (script.githubPath.startsWith('examples/')) {
    return `https://github.com/yeraze/meshmonitor/blob/main/${script.githubPath}`
  }
  
  // Otherwise, parse as external repo: "USERNAME/repo/branch/path" or "USERNAME/repo/path"
  const parts = script.githubPath.split('/')
  
  // Minimum: USERNAME/repo/path (3 parts) - defaults to main branch
  if (parts.length >= 3) {
    // Check if 3rd part looks like a branch name (common branches: main, master, develop)
    const commonBranches = ['main', 'master', 'develop', 'dev']
    const possibleBranch = parts[2]
    
    // If 3rd part is a branch name and we have at least 4 parts total, use it
    if (commonBranches.includes(possibleBranch.toLowerCase()) && parts.length >= 4) {
      // Format: USERNAME/repo/branch/path/to/file
      const username = parts[0]
      const repo = parts[1]
      const branch = parts[2]
      const filePath = parts.slice(3).join('/')
      return `https://github.com/${username}/${repo}/blob/${branch}/${filePath}`
    } else {
      // Format: USERNAME/repo/path/to/file (defaults to main branch)
      const username = parts[0]
      const repo = parts[1]
      const filePath = parts.slice(2).join('/')
      return `https://github.com/${username}/${repo}/blob/main/${filePath}`
    }
  }
  
  // Fallback: treat entire path as relative to main repo
  return `https://github.com/yeraze/meshmonitor/blob/main/${script.githubPath}`
}

/**
 * Get GitHub API URL for fetching file contents (supports CORS for public repos)
 * Uses GitHub Contents API instead of raw URLs to avoid CORS issues
 * 
 * Security: Validates path to prevent SSRF attacks before constructing URL.
 * 
 * @param {Object} script - Script object with githubPath property
 * @returns {string|null} GitHub API URL for fetching file content, or null if invalid
 */
const getGitHubApiUrl = (script) => {
  if (!script.githubPath) return null
  
  // Security: Validate path to prevent SSRF attacks
  if (!validateGitHubPath(script.githubPath)) {
    console.warn('Invalid GitHub path detected, rejecting:', script.githubPath)
    return null
  }
  
  // If path starts with "examples/", it's in the main meshmonitor repo
  if (script.githubPath.startsWith('examples/')) {
    const filePath = script.githubPath.substring('examples/'.length)
    return `https://api.github.com/repos/yeraze/meshmonitor/contents/${filePath}?ref=main`
  }
  
  // Otherwise, parse as external repo: "USERNAME/repo/branch/path" or "USERNAME/repo/path"
  const parts = script.githubPath.split('/')
  
  // Minimum: USERNAME/repo/path (3 parts) - defaults to main branch
  if (parts.length >= 3) {
    const commonBranches = ['main', 'master', 'develop', 'dev']
    const possibleBranch = parts[2]
    
    // If 3rd part is a branch name and we have at least 4 parts total, use it
    if (commonBranches.includes(possibleBranch.toLowerCase()) && parts.length >= 4) {
      // Format: USERNAME/repo/branch/path/to/file
      const username = parts[0]
      const repo = parts[1]
      const branch = parts[2]
      const filePath = parts.slice(3).join('/')
      return `https://api.github.com/repos/${username}/${repo}/contents/${filePath}?ref=${branch}`
    } else {
      // Format: USERNAME/repo/path/to/file (defaults to main branch)
      const username = parts[0]
      const repo = parts[1]
      const filePath = parts.slice(2).join('/')
      return `https://api.github.com/repos/${username}/${repo}/contents/${filePath}?ref=main`
    }
  }
  
  // Fallback: treat entire path as relative to main repo
  return `https://api.github.com/repos/yeraze/meshmonitor/contents/${script.githubPath}?ref=main`
}


// Highlight code using Prism.js
const highlightCode = async () => {
  if (!codeElement.value || !scriptCode.value) return
  
  await nextTick()
  
  // Dynamically import Prism.js
  try {
    const PrismModule = await import('prismjs')
    const Prism = PrismModule.default || PrismModule
    await import('prismjs/components/prism-python')
    await import('prismjs/components/prism-javascript')
    await import('prismjs/components/prism-bash')
    await import('prismjs/components/prism-typescript')
    
    const code = codeElement.value.querySelector('code')
    if (code) {
      Prism.highlightElement(code)
    }
  } catch (err) {
    console.warn('Failed to load Prism.js, using plain text:', err)
  }
}

// Watch for code changes and highlight
watch([scriptCode, selectedScript], async () => {
  if (scriptCode.value && selectedScript.value) {
    // Wait for DOM to update
    await nextTick()
    if (codeElement.value) {
      await highlightCode()
    }
  }
}, { flush: 'post' })

// Fetch script code from GitHub
// Docs are a separate static site (GitHub Pages), so we always use GitHub API directly
// GitHub's api.github.com supports CORS for public repositories
const fetchScriptCode = async (script) => {
  if (!script || scriptCode.value || loadingCode.value) return
  
  loadingCode.value = true
  codeError.value = null
  
  // Security: Maximum file size (500KB)
  const MAX_FILE_SIZE = 500 * 1024 // 500KB in bytes
  
  try {
    const apiUrl = getGitHubApiUrl(script)
    if (!apiUrl) {
      throw new Error('Unable to construct GitHub API URL')
    }
    
    // Security: Add timeout using AbortController (10 seconds)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)
    
    let response
    try {
      response = await fetch(apiUrl, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'MeshMonitor-UserScripts/1.0'
        }
      })
      clearTimeout(timeoutId)
    } catch (fetchErr) {
      clearTimeout(timeoutId)
      
      if ((fetchErr instanceof DOMException && fetchErr.name === 'AbortError') ||
          (fetchErr instanceof Error && fetchErr.name === 'AbortError')) {
        throw new Error('Request timeout after 10 seconds')
      }
      
      // If fetch fails (CORS, network error, etc.), provide helpful error
      if (fetchErr.message.includes('CORS') || 
          fetchErr.message.includes('Failed to fetch') ||
          fetchErr.message.includes('NetworkError')) {
        throw new Error('Unable to fetch script content. Please view source on GitHub directly.')
      }
      throw fetchErr
    }
    
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('File not found. The file may not exist or the repository may be private.')
      }
      if (response.status === 403) {
        throw new Error('Rate limit exceeded or repository is private. Please view source on GitHub directly.')
      }
      throw new Error(`Failed to fetch code: ${response.status} ${response.statusText}`)
    }
    
    // GitHub API returns JSON with base64-encoded content
    const data = await response.json()
    
    // Security: Validate response structure
    if (!data || typeof data !== 'object' || !data.content) {
      throw new Error('Invalid response format from GitHub API')
    }
    
    // Security: Check file size (GitHub API provides size in bytes)
    if (data.size && data.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${data.size} bytes. Maximum size is ${MAX_FILE_SIZE} bytes (500KB)`)
    }
    
    // Decode base64 content
    let text
    try {
      // GitHub API returns base64-encoded content with newlines, remove them
      const base64Content = data.content.replace(/\n/g, '')
      text = atob(base64Content)
    } catch (decodeErr) {
      throw new Error('Failed to decode file content from GitHub API')
    }
    
    // Security: Double-check size after decoding
    if (text.length > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${text.length} bytes. Maximum size is ${MAX_FILE_SIZE} bytes (500KB)`)
    }
    
    // Security: Detect HTML content
    const trimmedText = text.trim()
    if (trimmedText.startsWith('<!DOCTYPE') || trimmedText.startsWith('<html') || trimmedText.startsWith('<?xml')) {
      throw new Error('Received HTML content instead of code. The file may not exist or the URL may be incorrect.')
    }
    
    scriptCode.value = text
    // Highlight will be triggered by watch
  } catch (err) {
    codeError.value = `Error loading code: ${err.message}. Please view source.`
    console.error('Failed to fetch script code:', err)
  } finally {
    loadingCode.value = false
  }
}

// Copy script code
const copyScriptCode = async (script) => {
  if (!scriptCode.value && !loadingCode.value) {
    // Fetch code if not loaded
    await fetchScriptCode(script)
    // Wait for fetch to complete
    await new Promise(resolve => {
      const unwatch = watch([scriptCode, loadingCode], () => {
        if (!loadingCode.value && (scriptCode.value || codeError.value)) {
          unwatch()
          resolve()
        }
      })
    })
  }
  
  if (scriptCode.value) {
    try {
      await navigator.clipboard.writeText(scriptCode.value)
      codeCopied.value = true
      setTimeout(() => {
        codeCopied.value = false
      }, 2000)
    } catch (err) {
      console.error('Failed to copy code:', err)
    }
  }
}

// Security: Sanitize filename to prevent path traversal
const sanitizeFilename = (filename) => {
  if (!filename || typeof filename !== 'string') {
    return 'script.txt'
  }
  
  // Remove path traversal sequences
  let sanitized = filename.replace(/\.\./g, '').replace(/\.\.\//g, '').replace(/\.\.\\/g, '')
  
  // Remove path separators (prevent directory traversal)
  sanitized = sanitized.replace(/[\/\\]/g, '_')
  
  // Remove special characters except dots, hyphens, underscores
  sanitized = sanitized.replace(/[^a-zA-Z0-9._-]/g, '_')
  
  // Limit filename length (100 chars max)
  const MAX_FILENAME_LENGTH = 100
  if (sanitized.length > MAX_FILENAME_LENGTH) {
    const ext = sanitized.substring(sanitized.lastIndexOf('.'))
    const name = sanitized.substring(0, sanitized.lastIndexOf('.'))
    sanitized = name.substring(0, MAX_FILENAME_LENGTH - ext.length) + ext
  }
  
  // Ensure filename has valid extension or add .txt
  if (!sanitized.includes('.')) {
    sanitized += '.txt'
  }
  
  return sanitized || 'script.txt'
}

// Download script file
const downloadScript = async (script) => {
  if (!scriptCode.value && !loadingCode.value) {
    // Fetch code if not loaded
    await fetchScriptCode(script)
    // Wait for fetch to complete
    await new Promise(resolve => {
      const unwatch = watch([scriptCode, loadingCode], () => {
        if (!loadingCode.value && (scriptCode.value || codeError.value)) {
          unwatch()
          resolve()
        }
      })
    })
  }
  
  if (scriptCode.value) {
    try {
      // Security: Sanitize filename before download
      const safeFilename = sanitizeFilename(script.filename)
      
      // Create blob with script content
      const blob = new Blob([scriptCode.value], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      
      // Create temporary download link
      const link = document.createElement('a')
      link.href = url
      link.download = safeFilename
      document.body.appendChild(link)
      link.click()
      
      // Cleanup
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to download script:', err)
    }
  }
}

// Copy script (uses already loaded code or fetches if needed)
const copyScript = async (script, event) => {
  if (event) {
    const btn = event.target.closest('.copy-script, .copy-script-btn')
    if (btn) {
      const originalText = btn.textContent
      btn.textContent = 'Loading...'
      btn.disabled = true
      
      try {
        // Use copyScriptCode which handles fetching and copying
        await copyScriptCode(script)
        btn.textContent = '✓ Copied!'
        setTimeout(() => {
          btn.textContent = originalText
          btn.disabled = false
        }, 2000)
      } catch (err) {
        btn.textContent = 'Error'
        setTimeout(() => {
          btn.textContent = originalText
          btn.disabled = false
        }, 2000)
        console.error('Failed to copy script:', err)
      }
    }
  }
}
</script>

<style scoped>
.user-scripts-gallery {
  margin: 2rem 0;
}

/* Full-Screen Scripts Modal */
.scripts-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(4px);
  z-index: 9999;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  overflow: hidden;
}

.scripts-modal-content {
  width: 100%;
  height: 100%;
  background: var(--vp-c-bg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.scripts-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.5rem 2rem;
  border-bottom: 2px solid var(--vp-c-divider);
  flex-shrink: 0;
}

.scripts-modal-header h2 {
  margin: 0;
  font-size: 1.75rem;
  color: var(--vp-c-text-1);
}

.close-modal-btn {
  padding: 0.5rem 1rem;
  background: transparent;
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  white-space: nowrap;
  font-weight: 500;
}

.close-modal-btn:hover {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-brand);
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.close-modal-btn:focus-visible {
  outline: 2px solid var(--vp-c-brand);
  outline-offset: 2px;
}

.close-x {
  font-size: 1.2rem;
  line-height: 1;
  margin-left: 0.25rem;
}

.scripts-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 2rem;
  min-height: 0;
}

/* Transition animations */
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from, .fade-leave-to {
  opacity: 0;
}

.modal-enter-active, .modal-leave-active {
  transition: opacity 0.3s ease;
}

.modal-enter-from, .modal-leave-to {
  opacity: 0;
}

.modal-enter-active .modal-content,
.modal-leave-active .modal-content,
.modal-enter-active .scripts-modal-content,
.modal-leave-active .scripts-modal-content {
  transition: transform 0.3s ease, opacity 0.3s ease;
}

.modal-enter-from .modal-content,
.modal-leave-to .modal-content {
  transform: scale(0.9);
  opacity: 0;
}

.modal-enter-from .scripts-modal-content,
.modal-leave-to .scripts-modal-content {
  transform: scale(0.95);
  opacity: 0;
}

/* Docs View */
.docs-view {
  width: 100%;
}

.filters-section {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 1.5rem;
  margin-bottom: 2rem;
}

.filter-group {
  margin-bottom: 1rem;
}

.filter-group:last-child {
  margin-bottom: 0;
}

.filter-group label {
  display: block;
  font-weight: 600;
  color: var(--vp-c-text-1);
  margin-bottom: 0.75rem;
  font-size: 0.9rem;
}

.filter-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.filter-btn {
  padding: 0.5rem 1rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  color: var(--vp-c-text-2);
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 500;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.filter-btn:hover {
  border-color: var(--vp-c-brand);
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
  transform: translateY(-1px);
}

.filter-btn:focus-visible {
  outline: 2px solid var(--vp-c-brand);
  outline-offset: 2px;
}

.filter-btn.active {
  background: var(--vp-c-brand);
  color: var(--vp-c-bg);
  border-color: var(--vp-c-brand);
  font-weight: 600;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.tag-btn {
  font-size: 0.8rem;
  padding: 0.4rem 0.8rem;
}

.clear-filters {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--vp-c-divider);
}

.clear-btn {
  padding: 0.5rem 1rem;
  background: transparent;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  color: var(--vp-c-text-2);
  cursor: pointer;
  font-size: 0.875rem;
  transition: all 0.2s;
}

.clear-btn:hover {
  border-color: var(--vp-c-brand);
  color: var(--vp-c-brand);
}

.scripts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
  gap: 1.5rem;
  margin-bottom: 2rem;
}

.script-card {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 1.5rem;
  transition: all 0.2s;
}

.script-card:hover {
  border-color: var(--vp-c-brand);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1rem;
  gap: 1rem;
}

.script-name {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
  flex: 1;
}

.language-badge {
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}

.lang-python {
  background: #3776ab;
  color: white;
}

.lang-javascript {
  background: #f7df1e;
  color: #000;
}

.lang-shell {
  background: #89e051;
  color: #000;
}

.script-description {
  color: var(--vp-c-text-2);
  margin: 0 0 1rem 0;
  line-height: 1.6;
  font-size: 0.9rem;
}

.script-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.tag-chip {
  padding: 0.3rem 0.75rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--vp-c-text-2);
  transition: all 0.2s ease;
}

.tag-chip:hover {
  background: var(--vp-c-bg-soft);
  border-color: var(--vp-c-brand);
  transform: translateY(-1px);
}

.script-details {
  margin-bottom: 1rem;
  font-size: 0.875rem;
}

.detail-item {
  margin-bottom: 0.75rem;
}

.detail-item:last-child {
  margin-bottom: 0;
}

.detail-item strong {
  color: var(--vp-c-text-1);
  display: block;
  margin-bottom: 0.25rem;
}

.trigger-code {
  display: inline-block;
  background: var(--vp-c-bg);
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-family: 'Courier New', monospace;
  font-size: 0.85rem;
  color: var(--vp-c-brand);
  border: 1px solid var(--vp-c-divider);
}

.requirements-list {
  margin: 0.5rem 0 0 0;
  padding-left: 1.5rem;
  color: var(--vp-c-text-2);
  list-style-type: disc;
}

.requirements-list li {
  margin-bottom: 0.5rem;
  line-height: 1.5;
}

.requirements-list li:last-child {
  margin-bottom: 0;
}

.requirements {
  color: var(--vp-c-text-2);
  font-size: 0.85rem;
}

.card-actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--vp-c-divider);
}

.action-btn {
  flex: 1;
  padding: 0.5rem 1rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  color: var(--vp-c-text-1);
  cursor: pointer;
  font-size: 0.875rem;
  text-decoration: none;
  text-align: center;
  transition: all 0.2s;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
}

.action-btn:hover {
  background: var(--vp-c-brand);
  color: var(--vp-c-bg);
  border-color: var(--vp-c-brand);
}

.no-results {
  text-align: center;
  padding: 4rem 2rem;
  color: var(--vp-c-text-2);
}

.no-results-icon {
  font-size: 4rem;
  margin-bottom: 1rem;
  opacity: 0.5;
}

.no-results-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  margin: 0 0 0.5rem 0;
  letter-spacing: -0.02em;
}

.no-results-message {
  font-size: 1rem;
  color: var(--vp-c-text-2);
  margin: 0;
  line-height: 1.6;
  max-width: 500px;
  margin-left: auto;
  margin-right: auto;
}

.view-scripts-cta {
  text-align: center;
  margin: 3rem 0;
  padding: 3rem 2rem;
  background: var(--vp-c-bg-soft);
  border: 2px dashed var(--vp-c-divider);
  border-radius: 12px;
}

.cta-title {
  margin: 0 0 1rem 0;
  font-size: 1.75rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.cta-description {
  margin: 0 0 2rem 0;
  font-size: 1rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  max-width: 600px;
  margin-left: auto;
  margin-right: auto;
}

.cta-button {
  padding: 1rem 2rem;
  background: var(--vp-c-brand);
  color: var(--vp-c-bg);
  border: none;
  border-radius: 8px;
  font-size: 1.1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.cta-button:hover {
  background: var(--vp-c-brand-dark, var(--vp-c-brand));
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.cta-arrow {
  transition: transform 0.2s;
}

.cta-button:hover .cta-arrow {
  transform: translateX(4px);
}


.two-column-layout {
  display: flex;
  gap: 2rem;
  align-items: flex-start;
}

/* Sidebar */
.sidebar {
  width: 280px;
  flex-shrink: 0;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 1.5rem;
  position: sticky;
  top: 2rem;
  max-height: calc(100vh - 4rem);
  overflow-y: auto;
}

.sidebar-section {
  margin-bottom: 1.5rem;
}

.sidebar-section:last-child {
  margin-bottom: 0;
}

.sidebar-section label {
  display: block;
  font-weight: 600;
  color: var(--vp-c-text-1);
  margin-bottom: 0.75rem;
  font-size: 0.9rem;
}

.search-input {
  width: 100%;
  padding: 0.75rem 1rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  color: var(--vp-c-text-1);
  font-size: 0.9rem;
  font-weight: 400;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.search-input:focus {
  outline: none;
  border-color: var(--vp-c-brand);
  box-shadow: 0 0 0 3px rgba(var(--vp-c-brand-rgb, 0, 0, 0), 0.1), 0 2px 4px rgba(0, 0, 0, 0.05);
  transform: translateY(-1px);
}

.search-input::placeholder {
  color: var(--vp-c-text-3);
  opacity: 0.6;
}

.filter-buttons-vertical {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.results-count {
  padding-top: 1rem;
  border-top: 1px solid var(--vp-c-divider);
}

.count-text {
  margin: 0;
  font-size: 0.85rem;
  color: var(--vp-c-text-2);
}

.count-text strong {
  color: var(--vp-c-text-1);
}

/* Main Content */
.main-content {
  flex: 1;
  min-width: 0;
}

.scripts-grid-compact {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 1.5rem;
  margin-bottom: 2rem;
}

.script-card-compact {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 1.5rem;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  flex-direction: column;
  height: 100%;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.script-card-compact:hover {
  border-color: var(--vp-c-brand);
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

.script-card-compact:focus-within {
  outline: 2px solid var(--vp-c-brand);
  outline-offset: 2px;
}

.card-header-compact {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 0.75rem;
  gap: 1rem;
}

.header-left {
  flex: 1;
  min-width: 0;
}

.script-name-compact {
  margin: 0 0 0.25rem 0;
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  letter-spacing: -0.01em;
}

.script-icon {
  font-size: 1.25rem;
  line-height: 1;
  flex-shrink: 0;
}

.script-author {
  font-size: 0.8rem;
  color: var(--vp-c-text-2);
  font-weight: 500;
  opacity: 0.8;
}

.script-description-compact {
  color: var(--vp-c-text-2);
  margin: 0 0 0.75rem 0;
  line-height: 1.6;
  font-size: 0.875rem;
  font-weight: 400;
}

.script-tags-compact {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 0.75rem;
}

.card-actions-compact {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: auto;
  padding-top: 0.75rem;
  border-top: 1px solid var(--vp-c-divider);
}

.action-btn-compact {
  padding: 0.625rem 1rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  color: var(--vp-c-text-1);
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 600;
  text-decoration: none;
  text-align: center;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.action-btn-compact:hover {
  background: var(--vp-c-brand);
  color: var(--vp-c-bg);
  border-color: var(--vp-c-brand);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.action-btn-compact:active {
  transform: translateY(0);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

.action-btn-compact:focus-visible {
  outline: 2px solid var(--vp-c-brand);
  outline-offset: 2px;
}

.action-btn-compact:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

/* Pagination */
.pagination {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}

.pagination-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.9rem;
  color: var(--vp-c-text-2);
}

.items-per-page {
  padding: 0.4rem 0.75rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  color: var(--vp-c-text-1);
  font-size: 0.85rem;
  cursor: pointer;
}

.pagination-controls {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 0.5rem;
}

.page-btn {
  padding: 0.5rem 1rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  color: var(--vp-c-text-1);
  cursor: pointer;
  font-size: 0.875rem;
  transition: all 0.2s;
}

.page-btn:hover:not(:disabled) {
  background: var(--vp-c-brand);
  color: var(--vp-c-bg);
  border-color: var(--vp-c-brand);
}

.page-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.page-numbers {
  display: flex;
  gap: 0.25rem;
}

.page-number {
  min-width: 2.5rem;
  padding: 0.5rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  color: var(--vp-c-text-1);
  cursor: pointer;
  font-size: 0.875rem;
  transition: all 0.2s;
}

.page-number:hover:not(.active):not(:disabled) {
  background: var(--vp-c-bg-soft);
  border-color: var(--vp-c-brand);
}

.page-number.active {
  background: var(--vp-c-brand);
  color: var(--vp-c-bg);
  border-color: var(--vp-c-brand);
}

.page-number:disabled {
  cursor: default;
}

/* Modal */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  padding: 2rem;
  overflow-y: auto;
}

.modal-content {
  background: var(--vp-c-bg);
  border-radius: 12px;
  max-width: 1400px;
  width: 100%;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.5rem;
  border-bottom: 1px solid var(--vp-c-divider);
}

.modal-header-left {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex: 1;
  min-width: 0;
}

.modal-title {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  letter-spacing: -0.02em;
}

.modal-close {
  width: 2rem;
  height: 2rem;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--vp-c-text-2);
  font-size: 1.5rem;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-close:hover {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
  min-height: 0;
}

.modal-two-column {
  display: flex;
  gap: 2rem;
  align-items: flex-start;
  height: 100%;
}

.modal-details-column {
  flex: 0 0 400px;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  overflow-y: auto;
  max-height: calc(90vh - 200px);
  padding-right: 1rem;
}

.modal-code-column {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-left: 1px solid var(--vp-c-divider);
  padding-left: 2rem;
}

/* Responsive: Stack columns on smaller screens */
@media (max-width: 1024px) {
  .modal-content {
    max-width: 95vw;
  }
  
  .modal-two-column {
    flex-direction: column;
    gap: 1.5rem;
  }
  
  .modal-details-column {
    flex: 0 0 auto;
    max-height: none;
    padding-right: 0;
    border-bottom: 1px solid var(--vp-c-divider);
    padding-bottom: 1.5rem;
  }
  
  .modal-code-column {
    border-left: none;
    padding-left: 0;
    border-top: 1px solid var(--vp-c-divider);
    padding-top: 1.5rem;
  }
}

.detail-section {
  margin-bottom: 1.5rem;
}

.detail-section:last-child {
  margin-bottom: 0;
}

.detail-section h3 {
  margin: 0 0 0.5rem 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.detail-section p {
  margin: 0;
  color: var(--vp-c-text-2);
  line-height: 1.6;
}

.trigger-code-large {
  display: block;
  background: var(--vp-c-bg-soft);
  padding: 0.75rem;
  border-radius: 6px;
  font-family: 'Courier New', monospace;
  font-size: 0.9rem;
  color: var(--vp-c-brand);
  border: 1px solid var(--vp-c-divider);
}

.features-list-large {
  margin: 0.5rem 0 0 0;
  padding-left: 1.5rem;
  color: var(--vp-c-text-2);
}

.features-list-large li {
  margin-bottom: 0.5rem;
}

.code-viewer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--vp-c-divider);
}

.code-header-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.code-filename {
  font-family: 'Courier New', monospace;
  font-size: 0.9rem;
  color: var(--vp-c-text-2);
}

.copy-code-btn {
  padding: 0.5rem 1rem;
  background: var(--vp-c-brand);
  color: var(--vp-c-bg);
  border: none;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.copy-code-btn:hover:not(:disabled) {
  background: var(--vp-c-brand-dark, var(--vp-c-brand));
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
}

.copy-code-btn:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

.copy-code-btn:focus-visible {
  outline: 2px solid var(--vp-c-brand);
  outline-offset: 2px;
}

.copy-code-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

.download-code-btn {
  padding: 0.5rem 1rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  color: var(--vp-c-text-1);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.download-code-btn:hover:not(:disabled) {
  background: var(--vp-c-brand);
  color: var(--vp-c-bg);
  border-color: var(--vp-c-brand);
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
}

.download-code-btn:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

.download-code-btn:focus-visible {
  outline: 2px solid var(--vp-c-brand);
  outline-offset: 2px;
}

.download-code-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

.code-viewer {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  overflow: hidden;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 400px;
  max-height: calc(90vh - 300px);
}

.code-viewer pre {
  margin: 0;
  padding: 1.5rem;
  overflow-x: auto;
  overflow-y: auto;
  font-family: 'Courier New', 'Monaco', 'Menlo', 'Consolas', 'Fira Code', monospace;
  font-size: 0.875rem;
  line-height: 1.7;
  flex: 1;
  background: #1e1e1e;
  color: #d4d4d4;
}

.code-content {
  color: #d4d4d4;
  white-space: pre;
  display: block;
  background: transparent;
}

.code-block {
  margin: 0;
  background: #1e1e1e;
}

/* VS Code Dark+ theme syntax highlighting */
.code-viewer :deep(.token.comment),
.code-viewer :deep(.token.prolog),
.code-viewer :deep(.token.doctype),
.code-viewer :deep(.token.cdata) {
  color: #6a9955;
  font-style: italic;
}

.code-viewer :deep(.token.punctuation) {
  color: #d4d4d4;
}

.code-viewer :deep(.token.property),
.code-viewer :deep(.token.tag),
.code-viewer :deep(.token.boolean),
.code-viewer :deep(.token.number),
.code-viewer :deep(.token.constant),
.code-viewer :deep(.token.symbol),
.code-viewer :deep(.token.deleted) {
  color: #b5cea8;
}

.code-viewer :deep(.token.selector),
.code-viewer :deep(.token.attr-name),
.code-viewer :deep(.token.string),
.code-viewer :deep(.token.char),
.code-viewer :deep(.token.builtin),
.code-viewer :deep(.token.inserted) {
  color: #ce9178;
}

.code-viewer :deep(.token.operator),
.code-viewer :deep(.token.entity),
.code-viewer :deep(.token.url),
.code-viewer :deep(.language-css .token.string),
.code-viewer :deep(.style .token.string) {
  color: #d4d4d4;
}

.code-viewer :deep(.token.atrule),
.code-viewer :deep(.token.attr-value),
.code-viewer :deep(.token.keyword) {
  color: #569cd6;
}

.code-viewer :deep(.token.function),
.code-viewer :deep(.token.class-name) {
  color: #dcdcaa;
}

.code-viewer :deep(.token.regex),
.code-viewer :deep(.token.important),
.code-viewer :deep(.token.variable) {
  color: #d16969;
}

.code-loading-skeleton {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.skeleton-line {
  height: 1.2em;
  background: linear-gradient(90deg, #2d2d2d 25%, #3a3a3a 50%, #2d2d2d 75%);
  background-size: 200% 100%;
  animation: skeleton-loading 1.5s ease-in-out infinite;
  border-radius: 4px;
}

@keyframes skeleton-loading {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}

.code-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3rem 2rem;
  text-align: center;
  min-height: 200px;
}

.code-error-icon {
  font-size: 3rem;
  margin-bottom: 1rem;
  opacity: 0.7;
}

.code-error-message {
  color: var(--vp-c-red, #f87171);
  font-size: 1rem;
  line-height: 1.6;
  max-width: 500px;
}

.modal-footer {
  display: flex;
  gap: 1rem;
  padding: 1.5rem;
  border-top: 1px solid var(--vp-c-divider);
}

.modal-btn {
  flex: 1;
  padding: 0.75rem 1.5rem;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  color: var(--vp-c-text-1);
  cursor: pointer;
  font-size: 0.9rem;
  text-decoration: none;
  text-align: center;
  transition: all 0.2s;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}

.modal-btn:hover {
  background: var(--vp-c-brand);
  color: var(--vp-c-bg);
  border-color: var(--vp-c-brand);
}

.copy-script-btn {
  background: var(--vp-c-brand);
  color: var(--vp-c-bg);
  border-color: var(--vp-c-brand);
}

.copy-script-btn:hover {
  background: var(--vp-c-brand-dark, var(--vp-c-brand));
}

/* Responsive Design */
@media (max-width: 1024px) {
  .two-column-layout {
    flex-direction: column;
  }

  .sidebar {
    width: 100%;
    position: static;
    max-height: none;
  }

  .scripts-grid-compact {
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  }
}

@media (max-width: 768px) {
  .scripts-grid,
  .scripts-grid-compact {
    grid-template-columns: 1fr;
  }

  .view-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 1rem;
  }

  .modal-overlay {
    padding: 1rem;
  }

  .modal-content {
    max-height: 95vh;
  }

  .pagination-controls {
    flex-wrap: wrap;
  }

  .page-numbers {
    order: 3;
    width: 100%;
    justify-content: center;
    margin-top: 0.5rem;
  }
}
</style>

