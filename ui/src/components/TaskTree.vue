<script setup lang="ts">
import { computed } from 'vue';
import { navigate } from '../router';
import type { Task } from '../types';

/**
 * The task tree (v0.3 T4): the derived list rendered with single-parent
 * nesting — a task is indented one level per ancestor that is also visible.
 * Rows follow the derived order verbatim (due/priority/id), so a child may
 * appear before its parent when it sorts earlier; the indent carries the
 * structure. Every row links into the task detail route.
 */

const props = defineProps<{ tasks: Task[] }>();

interface Row {
  task: Task;
  depth: number;
}

const rows = computed<Row[]>(() => {
  const byId = new Map(props.tasks.map((task) => [task.id, task]));
  return props.tasks.map((task) => {
    let depth = 0;
    let parentId = task.parentId;
    while (parentId !== null && depth < 50) {
      const parent = byId.get(parentId);
      if (parent === undefined) {
        break; // parent not in the visible list — this row sits at top level
      }
      depth += 1;
      parentId = parent.parentId;
    }
    return { task, depth };
  });
});

const STATUS_LABEL: Record<Task['status'], string> = {
  pending: 'pending',
  active: 'active',
  waiting: 'waiting',
  done: 'done',
  dropped: 'dropped',
};

function dueLabel(task: Task): string {
  if (task.due === null) {
    return '';
  }
  return `due ${new Date(task.due).toLocaleString()}`;
}
</script>

<template>
  <ul class="task-tree">
    <li
      v-for="row in rows"
      :key="row.task.id"
      class="task-row"
      :class="[`depth-${row.depth}`, `status-${row.task.status}`]"
      :style="{ marginLeft: `${row.depth * 1.5}rem` }"
    >
      <button type="button" class="task-link" @click="navigate(`/ui/tasks/${row.task.id}`)">
        {{ row.task.title }}
      </button>
      <span class="badge" :class="`badge-${row.task.status}`">{{ STATUS_LABEL[row.task.status] }}</span>
      <span v-if="row.task.blocked" class="badge badge-blocked">blocked</span>
      <span v-if="row.task.hiddenUntil !== null" class="badge badge-soft">hidden</span>
      <span v-if="row.task.progress !== null" class="progress">{{ Math.round(row.task.progress * 100) }}%</span>
      <span v-if="row.task.priority" class="badge badge-soft">{{ row.task.priority }}</span>
      <span v-if="row.task.due !== null" class="meta">{{ dueLabel(row.task) }}</span>
      <span class="meta">{{ row.task.projectName ?? 'Unbound' }}</span>
      <span v-for="tag in row.task.tags" :key="tag" class="badge badge-soft">{{ tag }}</span>
    </li>
  </ul>
</template>
