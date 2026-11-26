<script setup lang="ts">
import { inject, ref } from 'vue';
import { injectApi } from '../api';
import { errorMessage } from '../form';
import type { Project } from '../types';
import type { Scope, ViewCounts, ViewName } from '../views';

/**
 * The navigation sidebar (v0.3 redesign, Todoist-style): the three views
 * with live in-scope counts, then the Projects section — explicit scope
 * selection (a browser has no cwd, ADR-0006), each project wearing a stable
 * color dot. The ＋ affordance creates a project in place: a name plus at
 * least one absolute bound path (the daemon requires paths — they are what
 * Current Project resolution matches against for agent callers).
 */

defineProps<{
  view: ViewName;
  scope: Scope;
  counts: ViewCounts;
  projects: Project[];
}>();

const emit = defineEmits<{
  'set-view': [view: ViewName];
  'set-scope': [scope: Scope];
  created: [];
}>();

const api = injectApi();

const creating = ref(false);
const newName = ref('');
const newPath = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);

async function submitProject(): Promise<void> {
  const name = newName.value.trim();
  const path = newPath.value.trim();
  if (name === '' || path === '' || submitting.value) {
    return;
  }
  submitting.value = true;
  error.value = null;
  try {
    await api.createProject({ name, paths: [path] });
    newName.value = '';
    newPath.value = '';
    creating.value = false;
    emit('created');
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    submitting.value = false;
  }
}

const VIEWS: { name: ViewName; label: string }[] = [
  { name: 'open', label: 'Open' },
  { name: 'today', label: 'Today' },
  { name: 'blocked', label: 'Blocked' },
];

const PALETTE = ['#d4713d', '#3d8fd4', '#7a5ad4', '#d43d8f', '#2f8f5b', '#c73a3a', '#8a6d00', '#3da3a3'];

function colorFor(id: number): string {
  return PALETTE[id % PALETTE.length]!;
}
</script>

<template>
  <aside class="sidebar">
    <div class="brand"><span class="brand-dot" /> Baton</div>

    <nav class="nav-section">
      <div class="nav-title">Views</div>
      <button
        v-for="entry in VIEWS"
        :key="entry.name"
        type="button"
        class="nav-item"
        :class="{ active: view === entry.name }"
        @click="emit('set-view', entry.name)"
      >
        <span class="nav-label">{{ entry.label }}</span>
        <span class="nav-count">{{ counts[entry.name] }}</span>
      </button>
    </nav>

    <nav class="nav-section">
      <div class="nav-title">
        Projects
        <button type="button" class="nav-add" aria-label="New project" @click="creating = !creating">＋</button>
      </div>
      <form v-if="creating" class="new-project" @submit.prevent="submitProject">
        <input v-model="newName" type="text" placeholder="Project name" aria-label="Project name" />
        <input v-model="newPath" type="text" placeholder="/absolute/bound/path" aria-label="Project path" />
        <div class="new-project-actions">
          <button type="submit" :disabled="newName.trim() === '' || newPath.trim() === '' || submitting">Create</button>
          <button type="button" @click="creating = false">Cancel</button>
        </div>
        <p v-if="error" class="error">{{ error }}</p>
      </form>
      <button type="button" class="nav-item" :class="{ active: scope === 'all' }" @click="emit('set-scope', 'all')">
        <span class="project-dot all" />
        <span class="nav-label">All projects</span>
      </button>
      <button type="button" class="nav-item" :class="{ active: scope === 'unbound' }" @click="emit('set-scope', 'unbound')">
        <span class="project-dot unbound" />
        <span class="nav-label">Unbound</span>
        <span class="nav-count">{{ counts.unbound }}</span>
      </button>
      <button
        v-for="project in projects"
        :key="project.id"
        type="button"
        class="nav-item"
        :class="{ active: scope === project.id }"
        @click="emit('set-scope', project.id)"
      >
        <span class="project-dot" :style="{ background: colorFor(project.id) }" />
        <span class="nav-label">{{ project.name }}</span>
        <span class="nav-count">{{ project.openTaskCount }}</span>
      </button>
    </nav>
  </aside>
</template>
