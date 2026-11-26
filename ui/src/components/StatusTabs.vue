<script setup lang="ts">
import { computed } from 'vue';
import { countViews, type Scope, type StatusTab, type ViewCounts } from '../views';
import type { Task } from '../types';

/**
 * The status tabs (GitHub issues style): Open / Done / Dropped with live
 * counts — the primary status filter of the list. Only rendered on the
 * sidebar's Open view; Today/Blocked are fixed composites.
 */

const props = defineProps<{
  tab: StatusTab;
  view: string;
  tasks: Task[];
  scope: Scope;
  now: number;
}>();

const emit = defineEmits<{ change: [tab: StatusTab] }>();

const TABS: { name: StatusTab; label: string }[] = [
  { name: 'open', label: 'Open' },
  { name: 'done', label: 'Done' },
  { name: 'dropped', label: 'Dropped' },
];

const counts = computed<ViewCounts>(() => countViews(props.tasks, props.scope, props.now));

function countFor(name: StatusTab): number {
  return counts.value[name];
}
</script>

<template>
  <nav v-if="view === 'open'" class="status-tabs" aria-label="Status">
    <button
      v-for="entry in TABS"
      :key="entry.name"
      type="button"
      class="status-tab"
      :class="{ active: tab === entry.name }"
      @click="emit('change', entry.name)"
    >
      {{ entry.label }}
      <span class="status-tab-count">{{ countFor(entry.name) }}</span>
    </button>
  </nav>
</template>
