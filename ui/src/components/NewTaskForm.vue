<script setup lang="ts">
import { ref } from 'vue';
import { injectApi } from '../api';
import { errorMessage, localToIso, parseTags } from '../form';
import type { Scope } from '../views';

/**
 * The quick-add bar (v0.3 redesign): title + Enter captures into the
 * current scope — Unbound under All/Unbound, the picker's project when one
 * is selected (the only assignment path, ADR-0006/0005). Optional fields
 * fold away behind the details toggle. No parent input here: subtasks are
 * added inline under their parent in the tree (capture-with-structure,
 * ADR-0006 amendment).
 */

const props = defineProps<{ scope: Scope }>();

const emit = defineEmits<{ created: [id: number] }>();

const api = injectApi();

const title = ref('');
const detailsOpen = ref(false);
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
    if (detailsOpen.value) {
      const tagsList = parseTags(tags.value);
      if (tagsList.length > 0) body.tags = tagsList;
      if (priority.value !== '') body.priority = priority.value;
      if (effort.value !== '') body.effort = effort.value;
      const dueIso = localToIso(due.value);
      if (dueIso !== null) body.due = dueIso;
      const hiddenIso = localToIso(hiddenUntil.value);
      if (hiddenIso !== null) body.hiddenUntil = hiddenIso;
    }
    // the selected project is the only assignment path; 'all'/'unbound' means Unbound
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
  <form class="quick-add" :class="{ open: detailsOpen }" @submit.prevent="submit">
    <span class="quick-add-glyph">＋</span>
    <input
      v-model="title"
      class="quick-add-title"
      type="text"
      placeholder="Add a task, press Enter to capture…"
      aria-label="New task title"
    />
    <button type="button" class="quick-add-details" :aria-expanded="detailsOpen" aria-label="Optional fields" @click="detailsOpen = !detailsOpen">
      ▾
    </button>

    <div v-if="detailsOpen" class="quick-add-fields">
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
    </div>

    <span v-if="error" class="error">{{ error }}</span>
  </form>
</template>
