<script setup lang="ts">
import { ref } from 'vue';
import { injectApi } from '../api';
import { errorMessage, localToIso, parseTags } from '../form';
import type { Scope } from '../views';

/**
 * Capture from the dashboard (v0.3 T6): title + optional fields. Defaults
 * Unbound; passing the picker's project is the ONLY project assignment and
 * there is deliberately no parent input — structural editing (reparent,
 * dependencies, project re-binding) is agent work over MCP (ADR-0006).
 */

const props = defineProps<{ scope: Scope }>();

const emit = defineEmits<{ created: [id: number] }>();

const api = injectApi();

const title = ref('');
const tags = ref('');
const priority = ref('');
const effort = ref('');
const due = ref('');
const hiddenUntil = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);

async function submit(): Promise<void> {
  if (title.value.trim() === '' || submitting.value) {
    return;
  }
  submitting.value = true;
  error.value = null;
  try {
    const body: Record<string, unknown> = { title: title.value.trim() };
    const tagsList = parseTags(tags.value);
    if (tagsList.length > 0) body.tags = tagsList;
    if (priority.value !== '') body.priority = priority.value;
    if (effort.value !== '') body.effort = effort.value;
    const dueIso = localToIso(due.value);
    if (dueIso !== null) body.due = dueIso;
    const hiddenIso = localToIso(hiddenUntil.value);
    if (hiddenIso !== null) body.hiddenUntil = hiddenIso;
    // the picker's project is the only assignment path; 'all'/'unbound' means Unbound
    if (typeof props.scope === 'number') body.project = props.scope;

    const { task } = await api.createTask(body);
    title.value = '';
    tags.value = '';
    priority.value = '';
    effort.value = '';
    due.value = '';
    hiddenUntil.value = '';
    emit('created', task.id);
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form class="new-task" @submit.prevent="submit">
    <input v-model="title" class="new-task-title" type="text" placeholder="New task…" aria-label="New task title" />
    <input v-model="tags" type="text" placeholder="tags, comma-separated" aria-label="Tags" />
    <select v-model="priority" aria-label="Priority">
      <option value="">priority</option>
      <option value="H">H</option>
      <option value="M">M</option>
      <option value="L">L</option>
    </select>
    <input v-model="effort" type="text" placeholder="effort" aria-label="Effort" />
    <input v-model="due" type="datetime-local" aria-label="Due" />
    <input v-model="hiddenUntil" type="datetime-local" aria-label="Hidden until" />
    <button type="submit" :disabled="title.trim() === '' || submitting">Create</button>
    <span v-if="error" class="error">{{ error }}</span>
  </form>
</template>
