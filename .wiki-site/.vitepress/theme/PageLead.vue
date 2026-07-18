<script setup lang="ts">
import { computed } from 'vue';
import { type DefaultTheme, useData, withBase } from 'vitepress';

interface WikiThemeConfig extends DefaultTheme.Config {
  startConcept?: { link: string; text: string };
}

const { page, frontmatter, site, theme } = useData<WikiThemeConfig>();
const isIndex = computed(() => page.value.relativePath === 'index.md');
const startConcept = computed(() => theme.value.startConcept);
const type = computed(() => stringValue(frontmatter.value.type));
const description = computed(() => stringValue(frontmatter.value.description));
const resource = computed(() => stringValue(frontmatter.value.resource));
const resourceUrl = computed(() => safeRemoteUrl(resource.value));
const timestamp = computed(() => stringValue(frontmatter.value.timestamp));
const tags = computed(() => {
  const value = frontmatter.value.tags;
  if (Array.isArray(value)) return value.map(String);
  return value ? [String(value)] : [];
});

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function safeRemoteUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}
</script>

<template>
  <section v-if="isIndex" class="bundle-lead">
    <p class="bundle-lead__eyebrow">OPEN KNOWLEDGE FORMAT · 0.1</p>
    <h1>{{ site.title }}</h1>
    <p>
      {{ site.description }} Every page below is both human-readable documentation and an
      agent-readable OKF concept.
    </p>
    <div class="bundle-lead__actions">
      <a v-if="startConcept" class="bundle-lead__primary" :href="withBase(startConcept.link)"
        >Start with {{ startConcept.text }}</a
      >
      <a :href="withBase('/okf/index.md')">Read the raw bundle</a>
    </div>
  </section>

  <aside v-else-if="type" class="concept-meta" aria-label="OKF concept metadata">
    <div class="concept-meta__topline">
      <span class="concept-meta__label">OKF concept</span>
      <span class="concept-meta__type">{{ type }}</span>
    </div>
    <p v-if="description" class="concept-meta__description">{{ description }}</p>
    <div v-if="tags.length || resource || timestamp" class="concept-meta__details">
      <div v-if="tags.length" class="concept-meta__tags" aria-label="Tags">
        <span v-for="tag in tags" :key="tag">{{ tag }}</span>
      </div>
      <a
        v-if="resourceUrl"
        class="concept-meta__resource"
        :href="resourceUrl"
        rel="noreferrer"
        target="_blank"
        >Canonical resource ↗</a
      >
      <code v-else-if="resource" class="concept-meta__resource-text">{{ resource }}</code>
      <time v-if="timestamp" :datetime="timestamp">Updated {{ timestamp }}</time>
    </div>
  </aside>
</template>
