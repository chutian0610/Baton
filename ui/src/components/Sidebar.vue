<script setup lang="ts">
import type { Project } from '../types';
import type { Scope, ViewCounts, ViewName } from '../views';

/**
 * The navigation sidebar (v0.3 redesign, Todoist-style): the three views
 * with live in-scope counts, then the Projects section — explicit scope
 * selection (a browser has no cwd, ADR-0006), each project wearing a stable
 * color dot. Replaces the old ViewTabs + ProjectPicker.
 */

defineProps<{
  view: ViewName;
  scope: Scope;
  counts: ViewCounts;
  projects: Project[];
}>();

const emit = defineEmits<{ 'set-view': [view: ViewName]; 'set-scope': [scope: Scope] }>();

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
      <div class="nav-title">Projects</div>
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
