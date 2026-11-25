<script setup lang="ts">
import { computed } from 'vue';
import { applyScope, isHiddenNow } from '../views';
import type { Scope, Visibility } from '../views';
import type { Task } from '../types';

/**
 * The three visibility toggles (v0.3 T4, spec: the observer's view must not
 * inherit the machine views' filtering rules): each re-adds its set on top of
 * the current view and labels it with a live count inside the current scope.
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

const TOGGLES: { key: keyof Visibility; label: string; title: string }[] = [
  { key: 'showDone', label: 'done', title: 'Show done tasks' },
  { key: 'showDropped', label: 'dropped', title: 'Show dropped tasks' },
  { key: 'showHidden', label: 'hidden', title: 'Show tasks hidden until a future time' },
];

function flip(key: keyof Visibility, event: Event): void {
  emit('change', { ...props.visibility, [key]: (event.target as HTMLInputElement).checked });
}
</script>

<template>
  <label v-for="toggle in TOGGLES" :key="toggle.key" class="visibility-toggle" :title="toggle.title">
    <input
      type="checkbox"
      :checked="visibility[toggle.key]"
      @change="flip(toggle.key, $event)"
    />
    {{ toggle.label }}
    <span class="count">{{ counts[toggle.key === 'showDone' ? 'done' : toggle.key === 'showDropped' ? 'dropped' : 'hidden'] }}</span>
  </label>
</template>
