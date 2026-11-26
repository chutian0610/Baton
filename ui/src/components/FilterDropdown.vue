<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { applyScope, isHiddenNow } from '../views';
import type { Scope, Visibility } from '../views';
import type { Task } from '../types';

/**
 * The filter dropdown (v0.3 redesign): one "Filter ▾" control instead of
 * loose checkboxes — it opens a small panel with the three visibility
 * options (done / dropped / hidden), each with a live in-scope count.
 * Zero-count options are disabled: they toggle nothing, so the empty set is
 * stated up front. The button wears an active-count badge. Closes on
 * outside click and Escape.
 */

const props = defineProps<{
  visibility: Visibility;
  tasks: Task[];
  scope: Scope;
  now: number;
}>();

const emit = defineEmits<{ change: [visibility: Visibility] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

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

const activeCount = computed(() => Object.values(props.visibility).filter(Boolean).length);

const OPTIONS: { key: keyof Visibility; label: string; title: string }[] = [
  { key: 'showDone', label: 'Done', title: 'Show done tasks' },
  { key: 'showDropped', label: 'Dropped', title: 'Show dropped tasks' },
  { key: 'showHidden', label: 'Hidden', title: 'Show tasks hidden until a future time' },
];

function countOf(key: keyof Visibility): number {
  return counts.value[key === 'showDone' ? 'done' : key === 'showDropped' ? 'dropped' : 'hidden'];
}

function optionDisabled(key: keyof Visibility): boolean {
  return countOf(key) === 0 && !props.visibility[key];
}

function flip(key: keyof Visibility, event: Event): void {
  emit('change', { ...props.visibility, [key]: (event.target as HTMLInputElement).checked });
}

function onDocumentClick(event: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node)) {
    open.value = false;
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    open.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div ref="root" class="filter-dropdown">
    <button type="button" class="filter-button" :aria-expanded="open" @click="open = !open">
      Filter
      <span v-if="activeCount > 0" class="filter-badge">{{ activeCount }}</span>
      <span class="filter-caret">▾</span>
    </button>

    <div v-if="open" class="filter-panel">
      <div class="filter-panel-title">Show also</div>
      <label
        v-for="option in OPTIONS"
        :key="option.key"
        class="filter-option"
        :class="{ disabled: optionDisabled(option.key) }"
        :title="option.title"
      >
        <input
          type="checkbox"
          :checked="visibility[option.key]"
          :disabled="optionDisabled(option.key)"
          @change="flip(option.key, $event)"
        />
        {{ option.label }}
        <span class="chip-count">{{ countOf(option.key) }}</span>
      </label>
    </div>
  </div>
</template>
