<script setup lang="ts">
import { computed } from 'vue';
import { applyScope, isHiddenNow } from '../views';
import type { Scope, Visibility } from '../views';
import type { Task } from '../types';

/**
 * The visibility filter chips (v0.3 redesign): pill-shaped toggles instead of
 * bare checkboxes — muted until active, filled when on, each with a live
 * count inside the current scope. The search box lives beside them in the
 * list toolbar (App.vue).
 */

const props = defineProps<{
  visibility: Visibility;
  tasks: Task[];
  scope: Scope;
  now: number;
}>();

const emit = defineEmits<{ change: [visibility: Visibility] }>();

const counts = computed(() => {
  const scoped = applyScope(props.tasks, props.scope);
  let done = 0;
  let dropped = 0;
  let hidden = 0;
  for (const task of scoped) {
    if (task.status === 'done') {
      done += 1;
    } else if (task.status === 'dropped') {
      dropped += 1;
    } else if (isHiddenNow(task, props.now)) {
      hidden += 1;
    }
  }
  return { done, dropped, hidden };
});

const CHIPS: { key: keyof Visibility; label: string; title: string }[] = [
  { key: 'showDone', label: 'done', title: 'Show done tasks' },
  { key: 'showDropped', label: 'dropped', title: 'Show dropped tasks' },
  { key: 'showHidden', label: 'hidden', title: 'Show tasks hidden until a future time' },
];

function flip(key: keyof Visibility, event: Event): void {
  emit('change', { ...props.visibility, [key]: (event.target as HTMLInputElement).checked });
}
</script>

<template>
  <label
    v-for="chip in CHIPS"
    :key="chip.key"
    class="filter-chip"
    :class="{ active: visibility[chip.key] }"
    :title="chip.title"
  >
    <input type="checkbox" :checked="visibility[chip.key]" @change="flip(chip.key, $event)" />
    {{ chip.label }}
    <span class="chip-count">{{ counts[chip.key === 'showDone' ? 'done' : chip.key === 'showDropped' ? 'dropped' : 'hidden'] }}</span>
  </label>
</template>
