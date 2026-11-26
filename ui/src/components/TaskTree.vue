<script setup lang="ts">
import { inject } from 'vue';
import type { Store } from '../store';
import type { TaskNode } from '../views';
import TaskNodeRow from './TaskNodeRow.vue';

/**
 * The task tree (v0.3 redesign): renders the store's derived tree —
 * expanded parents reveal their children inline (TaskNodeRow recurses),
 * collapse state lives in the store. The store is injected so a completion
 * click or a created subtask can refresh the shared data without an emit
 * chain through every level.
 */

defineProps<{ nodes: TaskNode[]; now: number }>();

const store = inject<Store>('store')!;
</script>

<template>
  <ul class="task-tree">
    <li v-for="node in nodes" :key="node.task.id" class="top-level">
      <TaskNodeRow :node="node" :now="now" @toggle="store.toggleExpanded" />
    </li>
  </ul>
</template>
