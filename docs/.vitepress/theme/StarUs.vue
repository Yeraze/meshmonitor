<template>
  <a
    :href="repoUrl + '/stargazers'"
    target="_blank"
    rel="noopener noreferrer"
    class="star-us"
  >
    <img
      :src="`https://img.shields.io/github/stars/${repo}?style=social`"
      alt="GitHub Stars"
    />
  </a>
</template>

<script setup lang="ts">
const repo = 'yeraze/meshmonitor'
const repoUrl = `https://github.com/${repo}`
</script>

<style scoped>
.star-us {
  display: flex;
  align-items: center;
  margin-left: 12px;
}

.star-us img {
  height: 20px;
  vertical-align: middle;
}
</style>
