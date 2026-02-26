<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'

const slides = [
  { src: '/images/main.png', label: 'Interactive Map', accent: '#6366f1' },
  { src: '/images/channels.png', label: 'Channel Messaging', accent: '#06b6d4' },
  { src: '/images/dashboard.png', label: 'Telemetry Dashboard', accent: '#f59e0b' },
  { src: '/images/device-config.png', label: 'Device Configuration', accent: '#10b981' },
  { src: '/images/features/admin-commands.png', label: 'Remote Administration', accent: '#ef4444' },
  { src: '/images/features/automation.png', label: 'Automation', accent: '#a855f7' },
  { src: '/images/features/security.png', label: 'Security Scanner', accent: '#f97316' },
]

const active = ref(0)
const direction = ref(1) // 1 = forward, -1 = backward
let timer = null
let isPaused = false

function next() {
  direction.value = 1
  active.value = (active.value + 1) % slides.length
}

function goTo(idx) {
  direction.value = idx > active.value ? 1 : -1
  active.value = idx
  resetTimer()
}

function resetTimer() {
  clearInterval(timer)
  timer = setInterval(() => {
    if (!isPaused) next()
  }, 5000)
}

function pause() { isPaused = true }
function resume() { isPaused = false }

onMounted(() => {
  resetTimer()
})

onUnmounted(() => {
  clearInterval(timer)
})

const accentColor = computed(() => slides[active.value].accent)
</script>

<template>
  <div class="hero-carousel" @mouseenter="pause" @mouseleave="resume">
    <div class="carousel-stage">
      <!-- Card stack: show all cards, position based on offset from active -->
      <div
        v-for="(slide, i) in slides"
        :key="i"
        class="carousel-card"
        :class="{
          'is-active': i === active,
          'is-prev': i === (active - 1 + slides.length) % slides.length,
          'is-next': i === (active + 1) % slides.length,
          'is-hidden': i !== active && i !== (active - 1 + slides.length) % slides.length && i !== (active + 1) % slides.length,
        }"
        :style="{
          '--accent': slide.accent,
        }"
        @click="goTo(i)"
      >
        <div class="card-inner">
          <img :src="slide.src" :alt="slide.label" loading="eager" />
          <div class="card-label">{{ slide.label }}</div>
        </div>
      </div>
    </div>

    <!-- Navigation dots -->
    <div class="carousel-dots">
      <button
        v-for="(slide, i) in slides"
        :key="i"
        class="dot"
        :class="{ 'is-active': i === active }"
        :style="{ '--dot-accent': slide.accent }"
        :aria-label="`Go to ${slide.label}`"
        @click="goTo(i)"
      />
    </div>
  </div>
</template>

<style scoped>
.hero-carousel {
  width: 100%;
  max-width: 620px;
  margin: 0 auto;
  user-select: none;
}

.carousel-stage {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 10;
  perspective: 1200px;
  perspective-origin: 50% 50%;
}

.carousel-card {
  position: absolute;
  inset: 0;
  transition: all 0.6s cubic-bezier(0.4, 0, 0.2, 1);
  cursor: pointer;
  border-radius: 12px;
  will-change: transform, opacity;
}

.card-inner {
  width: 100%;
  height: 100%;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  transition: box-shadow 0.6s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
}

.card-inner img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.card-label {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 8px 16px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.75));
  color: white;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.02em;
  opacity: 0;
  transition: opacity 0.4s ease;
}

/* Active card: front and center, glowing */
.carousel-card.is-active {
  transform: rotateY(0deg) translateZ(30px) scale(1);
  opacity: 1;
  z-index: 3;
}

.carousel-card.is-active .card-inner {
  box-shadow:
    0 8px 40px rgba(0, 0, 0, 0.4),
    0 0 30px color-mix(in srgb, var(--accent) 40%, transparent),
    0 0 60px color-mix(in srgb, var(--accent) 15%, transparent);
}

.carousel-card.is-active .card-label {
  opacity: 1;
}

/* Previous card: tucked behind to the left */
.carousel-card.is-prev {
  transform: rotateY(12deg) translateX(-45%) translateZ(-60px) scale(0.85);
  opacity: 0.5;
  z-index: 2;
  filter: brightness(0.7);
}

/* Next card: tucked behind to the right */
.carousel-card.is-next {
  transform: rotateY(-12deg) translateX(45%) translateZ(-60px) scale(0.85);
  opacity: 0.5;
  z-index: 2;
  filter: brightness(0.7);
}

/* Hidden cards */
.carousel-card.is-hidden {
  transform: translateZ(-120px) scale(0.7);
  opacity: 0;
  z-index: 1;
  pointer-events: none;
}

/* Dots */
.carousel-dots {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 20px;
}

.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--vp-c-text-3);
  background: transparent;
  cursor: pointer;
  padding: 0;
  transition: all 0.3s ease;
}

.dot:hover {
  border-color: var(--dot-accent);
  background: color-mix(in srgb, var(--dot-accent) 30%, transparent);
}

.dot.is-active {
  background: var(--dot-accent);
  border-color: var(--dot-accent);
  transform: scale(1.2);
  box-shadow: 0 0 8px color-mix(in srgb, var(--dot-accent) 50%, transparent);
}

/* Responsive */
@media (max-width: 768px) {
  .hero-carousel {
    max-width: 100%;
    padding: 0 16px;
  }

  .carousel-card.is-prev {
    transform: rotateY(8deg) translateX(-30%) translateZ(-40px) scale(0.88);
  }

  .carousel-card.is-next {
    transform: rotateY(-8deg) translateX(30%) translateZ(-40px) scale(0.88);
  }
}
</style>
