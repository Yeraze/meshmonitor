import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import StarUs from './StarUs.vue'
import DockerComposeConfigurator from './DockerComposeConfigurator.vue'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-content-after': () => h(StarUs)
    })
  },
  enhanceApp({ app }) {
    app.component('DockerComposeConfigurator', DockerComposeConfigurator)
  }
}
