<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { Scope, StatusFilterState } from '../views';
import type { Task, TaskStatus } from '../types';

/**
 * The status dropdown (GitHub "Types" style): multi-select over the Open
 * tab's own statuses (pending / active / waiting) with colored dots and
 * live in-scope counts. The archive statuses (done / dropped) are NOT
 * listed — they belong to their tabs, and dead disabled rows read as a
 * broken UI. "Show hidden" sits below a divider (a time mask, not a
 * status). The last checked option cannot be unchecked — the Open tab never
 * goes empty via the dropdown. Closes on outside click and Escape; only
 * rendered while the Open tab is active.
 */

const props = defineProps<{
  status: StatusFilterState;
  tasks: Task[];
  scope: Scope;
  now: number;
}>();

const emit = defineEmits<{
  'toggle-status': [status: TaskStatus];
  'set-show-hidden': [show: boolean];
}>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const STATUS_META: { status: TaskStatus; label: string; sub: string }[] = [
  { status: 'pending', label: 'Pending', sub: 'waiting to start' },
  { status: 'active', label: 'Active', sub: 'being worked on' },
  { status: 'waiting', label: 'Waiting', sub: 'parked for later' },
];

function scopedTasks(): Task[] {
  if (props.scope === 'all') {
    return props.tasks;
  }
  if (props.scope === 'unbound') {
    return props.tasks.filter((task) => task.projectId === null);
  }
  return props.tasks.filter((task) => task.projectId === props.scope);
}

function countOf(status: TaskStatus): number {
  return scopedTasks().filter((task) => task.status === status).length;
}

/** The last checked option stays checked — the Open tab never goes empty via the dropdown. */
function optionDisabled(status: TaskStatus): boolean {
  const explicit = props.status.statuses;
  return explicit !== null && explicit.length === 1 && explicit[0] === status;
}

function checked(status: TaskStatus): boolean {
  return props.status.statuses === null || props.status.statuses.includes(status);
}

function toggle(status: TaskStatus): void {
  emit('toggle-status', status);
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
  <div v-if="status.tab === 'open'" ref="root" class="filter-dropdown">
    <button type="button" class="filter-button" :aria-expanded="open" @click="open = !open">
      Status
      <span v-if="status.statuses !== null" class="filter-badge">{{ status.statuses.length }}</span>
      <span class="filter-caret">▾</span>
    </button>

    <div v-if="open" class="filter-panel">
      <div class="filter-panel-title">Filter by status</div>
      <label
        v-for="meta in STATUS_META"
        :key="meta.status"
        class="filter-option"
        :class="{ disabled: optionDisabled(meta.status) }"
        :title="`Show only ${meta.label.toLowerCase()} tasks`"
      >
        <input type="checkbox" :checked="checked(meta.status)" :disabled="optionDisabled(meta.status)" @change="toggle(meta.status)" />
        <span class="status-dot" :class="`status-dot-${meta.status}`" />
        <span class="filter-option-body">
          <span class="filter-option-label">{{ meta.label }}</span>
          <span class="filter-option-sub">{{ countOf(meta.status) }} in scope · {{ meta.sub }}</span>
        </span>
      </label>
      <div class="filter-divider" />
      <label class="filter-option" title="Show tasks hidden until a future time">
        <input type="checkbox" :checked="status.showHidden" @change="emit('set-show-hidden', ($event.target as HTMLInputElement).checked)" />
        <span class="filter-option-body">
          <span class="filter-option-label">Show hidden</span>
          <span class="filter-option-sub">tasks with hidden_until in the future</span>
        </span>
      </label>
    </div>
  </div>
</template>
