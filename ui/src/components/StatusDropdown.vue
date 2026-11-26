<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { countViews, OPEN_STATUSES, type Scope, type StatusFilterState } from '../views';
import type { Task, TaskStatus } from '../types';

/**
 * The status dropdown (GitHub "Types" style): multi-select over the five
 * statuses with colored dots and live counts, narrowing the Open tab
 * (pending / active / waiting); the archive statuses (done / dropped) are
 * listed disabled with a pointer to their tabs. "Show hidden" sits below a
 * divider — it is a time mask, not a status. Closes on outside click and
 * Escape; only rendered while the Open tab is active.
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

const counts = computed(() => countViews(props.tasks, props.scope, props.now));

const STATUS_META: { status: TaskStatus; label: string }[] = [
  { status: 'pending', label: 'Pending' },
  { status: 'active', label: 'Active' },
  { status: 'waiting', label: 'Waiting' },
  { status: 'done', label: 'Done' },
  { status: 'dropped', label: 'Dropped' },
];

function countOf(status: TaskStatus): number {
  if (OPEN_STATUSES.includes(status)) {
    return counts.value.open;
  }
  return status === 'done' ? counts.value.done : counts.value.dropped;
}

/** Per-status counts for the Open composite statuses need a finer count than countViews gives. */
function openStatusCount(status: TaskStatus): number {
  const scoped = applyScopeLocal();
  return scoped.filter((task) => task.status === status).length;
}

function applyScopeLocal(): Task[] {
  if (props.scope === 'all') {
    return props.tasks;
  }
  if (props.scope === 'unbound') {
    return props.tasks.filter((task) => task.projectId === null);
  }
  return props.tasks.filter((task) => task.projectId === props.scope);
}

function optionDisabled(status: TaskStatus): boolean {
  if (!OPEN_STATUSES.includes(status)) {
    return true; // archive statuses belong to their tabs
  }
  const explicit = props.status.statuses;
  return explicit !== null && explicit.length === 1 && explicit[0] === status && props.status.statuses !== null;
}

function checked(status: TaskStatus): boolean {
  if (OPEN_STATUSES.includes(status)) {
    return props.status.statuses === null || props.status.statuses.includes(status);
  }
  return false;
}

function toggle(status: TaskStatus, event: Event): void {
  emit('toggle-status', status);
  void event;
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
      >
        <input type="checkbox" :checked="checked(meta.status)" :disabled="optionDisabled(meta.status)" @change="toggle(meta.status, $event)" />
        <span class="status-dot" :class="`status-dot-${meta.status}`" />
        <span class="filter-option-body">
          <span class="filter-option-label">{{ meta.label }}</span>
          <span class="filter-option-sub">{{ openStatusCount(meta.status) }} in scope</span>
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
