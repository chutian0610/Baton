<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import { injectApi } from '../api';
import { errorMessage } from '../form';
import { navigate } from '../router';
import type { Store } from '../store';
import { isHiddenNow, type TaskNode } from '../views';

/**
 * One tree row (v0.3 redesign), recursive over its rendered children:
 * expand/collapse chevron, a completion circle (done <-> pending — the two
 * machine-legal directions a single control can safely offer; every other
 * transition lives in the detail panel), the title deep link, badges, and
 * metadata. An expanded parent renders its children plus an inline
 * "add subtask" input — capture-with-structure per the ADR-0006 amendment;
 * a created subtask inherits its parent's project at create time (explicit
 * in the request) or lands Unbound under an Unbound parent. Mutations go
 * through the injected store so the whole tree reconciles immediately.
 */

const props = defineProps<{ node: TaskNode; now: number }>();

const api = injectApi();
const store = inject<Store>('store')!;

const addingChild = ref(false);
const childTitle = ref('');
const childError = ref<string | null>(null);
const busy = ref(false);

const task = computed(() => props.node.task);
const expanded = computed(() => props.node.children.length > 0);

async function toggleDone(): Promise<void> {
  const target = task.value.status === 'done' ? 'pending' : 'done';
  busy.value = true;
  try {
    await api.updateTask(task.value.id, { status: target });
    await store.refresh();
  } catch (err) {
    // leave the row as-is; the next poll reconciles
    childError.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
}

async function submitChild(): Promise<void> {
  const title = childTitle.value.trim();
  if (title === '' || busy.value) {
    return;
  }
  busy.value = true;
  childError.value = null;
  try {
    const body: Record<string, unknown> = { title, parent: task.value.id };
    if (task.value.projectId !== null) {
      body.project = task.value.projectId; // inherit the parent's project at create (explicit)
    }
    await api.createTask(body);
    childTitle.value = '';
    // make sure the fresh child is visible under its parent
    store.state.expanded.add(task.value.id);
    await store.refresh();
  } catch (err) {
    childError.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
}

function dueLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
</script>

<template>
  <div class="task-branch" :class="{ 'has-children': node.childCount > 0 }">
    <div class="task-row" :class="[`status-${task.status}`]" :style="{ paddingLeft: `${props.node.depth * 1.4 + 0.6}rem` }">
      <button
        v-if="node.childCount > 0"
        type="button"
        class="chevron"
        :class="{ open: expanded }"
        :aria-label="expanded ? 'Collapse subtasks' : 'Expand subtasks'"
        @click="$emit('toggle', task.id)"
      >
        ▸
      </button>
      <span v-else class="chevron-spacer" />

      <button
        type="button"
        class="check"
        :class="{ done: task.status === 'done' }"
        :aria-label="task.status === 'done' ? 'Reopen task' : 'Complete task'"
        :disabled="busy"
        @click="toggleDone"
      >
        {{ task.status === 'done' ? '✓' : '' }}
      </button>

      <button type="button" class="title" @click="navigate(`/ui/tasks/${task.id}`)">{{ task.title }}</button>

      <span v-if="task.blocked" class="badge badge-blocked">blocked</span>
      <span v-if="task.status === 'active'" class="badge badge-active">active</span>
      <span v-if="task.status === 'waiting'" class="badge badge-waiting">waiting</span>
      <span v-if="task.status === 'dropped'" class="badge badge-dropped">dropped</span>
      <span v-if="task.hiddenUntil !== null && isHiddenNow(task, now)" class="badge badge-soft">hidden</span>
      <span v-if="task.progress !== null" class="progress">{{ Math.round(task.progress * 100) }}%</span>
      <span v-if="node.childCount > 0" class="subtask-count" :class="{ done: expanded }">{{ node.childCount }}</span>

      <span class="row-meta">
        <span v-if="task.due !== null" class="due">{{ dueLabel(task.due) }}</span>
        <span v-if="task.priority" class="prio">{{ task.priority }}</span>
        <span v-if="task.projectName" class="project-chip"><span class="project-dot" /> {{ task.projectName }}</span>
        <span v-for="tag in task.tags" :key="tag" class="tag-chip">{{ tag }}</span>
      </span>
    </div>

    <div v-if="childError" class="row-error">{{ childError }}</div>

    <div v-if="expanded" class="children">
      <TaskNodeRow
        v-for="child in node.children"
        :key="child.task.id"
        :node="child"
        :now="now"
        @toggle="$emit('toggle', $event)"
      />
      <form class="add-subtask" :style="{ marginLeft: `${(props.node.depth + 1) * 1.4 + 0.6}rem` }" @submit.prevent="submitChild">
        <span class="add-glyph">＋</span>
        <input
          v-model="childTitle"
          type="text"
          :placeholder="`Add subtask under “${task.title}”…`"
          :aria-label="`New subtask title under ${task.title}`"
          @focus="addingChild = true"
          @blur="addingChild = false"
        />
        <button type="submit" :disabled="childTitle.trim() === '' || busy">Add</button>
      </form>
    </div>
  </div>
</template>
