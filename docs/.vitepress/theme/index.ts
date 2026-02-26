import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import StarUs from './StarUs.vue'
import DockerComposeConfigurator from './DockerComposeConfigurator.vue'
import UserScriptsGallery from './UserScriptsGallery.vue'
import HeroCarousel from './HeroCarousel.vue'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-content-after': () => h(StarUs),
      'home-hero-image': () => h(HeroCarousel),
    })
  },
  enhanceApp({ app }) {
    app.component('DockerComposeConfigurator', DockerComposeConfigurator)
    app.component('UserScriptsGallery', UserScriptsGallery)
  }
}
