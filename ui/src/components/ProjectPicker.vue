<script setup lang="ts">
import type { Project } from '../types';
import type { Scope } from '../views';

/**
 * The project picker (v0.3 T3): a browser has no cwd, so scoping is an
 * explicit selection (ADR-0006) — All, Unbound, or one project. The store
 * persists the choice across reloads (src/store.ts).
 */

defineProps<{
  scope: Scope;
  projects: Project[];
}>();

const emit = defineEmits<{ change: [scope: Scope] }>();

function onSelect(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit('change', value === 'all' || value === 'unbound' ? value : Number(value));
}
</script>

<template>
  <select class="project-picker" aria-label="Project" :value="typeof scope === 'number' ? String(scope) : scope" @change="onSelect">
    <option value="all">All projects</option>
    <option value="unbound">Unbound</option>
    <option v-for="project in projects" :key="project.id" :value="String(project.id)">
      {{ project.name }}
    </option>
  </select>
</template>
