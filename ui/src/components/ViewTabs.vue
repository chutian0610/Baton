<script setup lang="ts">
import type { ViewName } from '../views';

/** The three entry views (v0.3 T4). Project scoping lives in the picker. */

defineProps<{ view: ViewName }>();

const emit = defineEmits<{ change: [view: ViewName] }>();

const TABS: { name: ViewName; label: string }[] = [
  { name: 'open', label: 'Open' },
  { name: 'today', label: 'Today' },
  { name: 'blocked', label: 'Blocked' },
];
</script>

<template>
  <nav class="view-tabs" aria-label="Views">
    <button
      v-for="tab in TABS"
      :key="tab.name"
      type="button"
      :class="{ active: view === tab.name }"
      :aria-current="view === tab.name ? 'page' : undefined"
      @click="emit('change', tab.name)"
    >
      {{ tab.label }}
    </button>
  </nav>
</template>
