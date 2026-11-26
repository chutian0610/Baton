<script setup lang="ts">
import { computed, inject, onUnmounted, ref, watch } from 'vue';
import { injectApi } from '../api';
import { errorMessage, isoToLocal, localToIso, parseTags, timeAgo } from '../form';
import { navigate } from '../router';
import { legalTargets } from '../transitions';
import type { Actor, Change, Project, TaskDetailPayload, TaskStatus } from '../types';

/**
 * The task detail panel: the audit window (annotations, intervals, deps,
 * paged history) plus per-field editing — every property row edits and saves
 * on its own (click the value, Enter saves, Esc cancels); tags render as an
 * array of chips with add/remove; Project binds via a select (PATCH
 * {project}, whole-subtree cascade, ADR-0006 second amendment). Structural
 * editing that stays agent-side: reparenting and dependency changes. The
 * panel re-polls so agent mutations surface live.
 */

const props = withDefaults(defineProps<{ id: number; pollMs?: number }>(), { pollMs: 5000 });

const emit = defineEmits<{ mutated: [] }>();

const api = injectApi();

const detail = ref<TaskDetailPayload | null>(null);
const error = ref<string | null>(null);
const actionError = ref<string | null>(null);
const projects = ref<Project[]>([]);

// ------------------------------------------------------------ change log (paged)

const changes = ref<Change[]>([]);
const changesTotal = ref(0);
const changesLoading = ref(false);

async function loadChangesPage(): Promise<void> {
  changesLoading.value = true;
  try {
    const page = await api.getChanges(props.id, 100, changes.value.length);
    changes.value = changes.value.concat(page.changes);
    changesTotal.value = page.total;
  } finally {
    changesLoading.value = false;
  }
}

async function load(id: number, keepVisible = false): Promise<void> {
  if (!keepVisible) {
    detail.value = null;
    changes.value = [];
    changesTotal.value = 0;
    editingField.value = null;
  }
  error.value = null;
  try {
    detail.value = await api.getTask(id);
    await loadChangesPage();
  } catch (err) {
    if (!keepVisible) {
      error.value = errorMessage(err);
    }
  }
}

// Polling: the audit window follows the store; quiet reloads keep the view
// until fresh data lands. Polls pause while the tab is hidden.
const pollTimer = ref<ReturnType<typeof setInterval> | undefined>();

function startPolling(): void {
  stopPolling();
  pollTimer.value = setInterval(() => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      void load(props.id, true);
    }
  }, props.pollMs);
}

function stopPolling(): void {
  if (pollTimer.value !== undefined) {
    clearInterval(pollTimer.value);
    pollTimer.value = undefined;
  }
}

async function act(write: () => Promise<unknown>): Promise<void> {
  actionError.value = null;
  try {
    await write();
    await load(props.id, true);
    emit('mutated');
  } catch (err) {
    actionError.value = errorMessage(err);
  }
}

// ------------------------------------------------------------ change log rendering

interface DiffEntry {
  field: string;
  before: string;
  after: string;
}

const FIELD_NAMES: Record<string, string> = {
  projectId: 'project',
  parentId: 'parent',
  hiddenUntil: 'hidden until',
};

function humanField(field: string): string {
  return FIELD_NAMES[field] ?? field;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? '(empty)' : value.join(', ');
  }
  if (typeof value === 'string') {
    return value === '' ? '(empty)' : value;
  }
  return JSON.stringify(value);
}

function diffEntries(change: Change): DiffEntry[] {
  return Object.entries(change.diff)
    .filter(([field, delta]) => field === 'title' || JSON.stringify(delta.before) !== JSON.stringify(delta.after))
    .map(([field, delta]) => ({
      field: humanField(field),
      before: formatValue(delta.before),
      after: formatValue(delta.after),
    }));
}

function createSummary(change: Change): { field: string; value: string }[] {
  return Object.entries(change.diff)
    .filter(([field, delta]) => field !== 'title' && delta.before === null && delta.after !== null)
    .map(([field, delta]) => ({ field: humanField(field), value: formatValue(delta.after) }))
    .filter((entry) => entry.value !== '(empty)');
}

function actorLabel(actor: Actor): string {
  return actor.kind === 'mcp' ? (actor.clientName ?? 'mcp') : actor.kind;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatInterval(startedAt: string, endedAt: string | null): string {
  const start = formatWhen(startedAt);
  return endedAt === null ? `${start} — active now` : `${start} — ${formatWhen(endedAt)}`;
}

function formatTotal(ms: number): string {
  if (ms < 1000) {
    return '<1s';
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.round(seconds / 60)}m`;
}

// ------------------------------------------------------------ per-field editing

type EditableField = 'title' | 'priority' | 'effort' | 'due' | 'hiddenUntil';

const editingField = ref<EditableField | null>(null);
const draft = ref('');

function startEdit(field: EditableField): void {
  const task = detail.value!.task;
  draft.value =
    field === 'title'
      ? task.title
      : field === 'priority'
        ? (task.priority ?? '')
        : field === 'effort'
          ? (task.effort ?? '')
          : isoToLocal(field === 'due' ? task.due : task.hiddenUntil);
  editingField.value = field;
}

function cancelEdit(): void {
  editingField.value = null;
}

function saveEdit(field: EditableField): void {
  if (field === 'title' || field === 'effort') {
    const value = draft.value.trim();
    if (value === '') {
      return; // titles cannot be empty; effort clears via ✕ instead
    }
    void act(async () => {
      await api.updateTask(props.id, { [field]: value });
      editingField.value = null;
    });
    return;
  }
  if (field === 'priority') {
    void act(async () => {
      await api.updateTask(props.id, { priority: draft.value === '' ? null : draft.value });
      editingField.value = null;
    });
    return;
  }
  void act(async () => {
    await api.updateTask(props.id, { [field]: localToIso(draft.value) });
    editingField.value = null;
  });
}

// ------------------------------------------------------------ project binding

function saveProject(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  const project = value === 'unbound' ? null : Number(value);
  void act(() => api.updateTask(props.id, { project }));
}

// ------------------------------------------------------------ tags (array chips)

const tagAdding = ref(false);
const newTag = ref('');

function removeTag(tag: string): void {
  const next = detail.value!.task.tags.filter((entry) => entry !== tag);
  void act(() => api.updateTask(props.id, { tags: next }));
}

function addTag(): void {
  const tag = newTag.value.trim().toLowerCase();
  if (tag === '' || detail.value!.task.tags.includes(tag)) {
    newTag.value = '';
    return;
  }
  void act(async () => {
    await api.updateTask(props.id, { tags: [...detail.value!.task.tags, tag] });
    newTag.value = '';
    tagAdding.value = false;
  });
}

// ------------------------------------------------------------ annotate

const annotationDraft = ref('');

function submitAnnotation(): void {
  const body = annotationDraft.value.trim();
  if (body === '') {
    return;
  }
  void act(async () => {
    await api.annotate(props.id, body);
    annotationDraft.value = '';
  });
}

// ------------------------------------------------------------ transitions

const targets = computed<TaskStatus[]>(() => (detail.value ? legalTargets(detail.value.task.status) : []));

function transitionTo(target: TaskStatus): void {
  void act(() => api.updateTask(props.id, { status: target }));
}

function savePriority(event: Event): void {
  draft.value = (event.target as HTMLSelectElement).value;
  saveEdit('priority');
}

// ------------------------------------------------------------ deps

async function loadDep(id: number): Promise<{ id: number; title: string; status: string; blocked: boolean } | null> {
  try {
    const payload = await api.getTask(id);
    return payload.task;
  } catch {
    return null;
  }
}

const depRows = ref<Awaited<ReturnType<typeof loadDep>>[]>([]);

watch(
  () => detail.value?.task.deps,
  async (deps) => {
    depRows.value = deps === undefined ? [] : (await Promise.all(deps.map(loadDep))).filter((row) => row !== null);
  },
  { immediate: true, deep: true },
);

// The id watch runs the whole load chain, so it registers last — after every
// ref and function it touches exists (immediate firing is synchronous).
watch(
  () => props.id,
  (id) => {
    void load(id);
    void api.listProjects().then((payload) => {
      projects.value = payload.projects;
    });
    startPolling();
  },
  { immediate: true },
);

onUnmounted(stopPolling);
</script>

<template>
  <article v-if="detail">
    <template v-if="editingField === 'title'">
      <input
        v-model="draft"
        class="field-editor title-editor"
        type="text"
        aria-label="Edit title"
        @keydown.enter.prevent="saveEdit('title')"
        @keydown.esc.prevent="cancelEdit"
      />
    </template>
    <template v-else>
      <h1 class="editable" title="Click to edit the title" @click="startEdit('title')">{{ detail.task.title }}</h1>
    </template>

    <p class="detail-status">
      <span class="badge" :class="`badge-${detail.task.status}`">{{ detail.task.status }}</span>
      <span v-if="detail.task.blocked" class="badge badge-blocked">blocked</span>
      <span v-if="detail.task.progress !== null" class="progress">{{ Math.round(detail.task.progress * 100) }}%</span>
    </p>

    <p v-if="actionError" class="error">{{ actionError }}</p>

    <section class="transitions">
      <button
        v-for="target in targets"
        :key="target"
        type="button"
        class="transition-pill"
        :class="`pill-${target}`"
        @click="transitionTo(target)"
      >
        → {{ target }}
      </button>
    </section>

    <section class="fields">
      <div class="prop-row">
        <span class="prop-label">Project</span>
        <select
          class="prop-select"
          aria-label="Project"
          :value="detail.task.projectId ?? 'unbound'"
          @change="saveProject"
        >
          <option value="unbound">Unbound</option>
          <option v-for="project in projects" :key="project.id" :value="String(project.id)">
            {{ project.name }}
          </option>
        </select>
        <span class="prop-hint">binding cascades to the whole subtree</span>
      </div>

      <div class="prop-row">
        <span class="prop-label">Priority</span>
        <select class="prop-select slim" aria-label="Priority" :value="detail.task.priority ?? ''" @change="savePriority">
          <option value="">—</option>
          <option value="H">H</option>
          <option value="M">M</option>
          <option value="L">L</option>
        </select>
      </div>

      <div class="prop-row">
        <span class="prop-label">Effort</span>
        <template v-if="editingField === 'effort'">
          <input
            v-model="draft"
            class="field-editor"
            type="text"
            aria-label="Edit effort"
            @keydown.enter.prevent="saveEdit('effort')"
            @keydown.esc.prevent="cancelEdit"
          />
          <button type="button" class="mini-btn" @click="saveEdit('effort')">✓</button>
          <button type="button" class="mini-btn" @click="cancelEdit">✕</button>
        </template>
        <template v-else>
          <button type="button" class="prop-value" :class="{ empty: detail.task.effort === null }" @click="startEdit('effort')">
            {{ detail.task.effort ?? '—' }}
          </button>
        </template>
      </div>

      <div class="prop-row">
        <span class="prop-label">Due</span>
        <template v-if="editingField === 'due'">
          <input
            v-model="draft"
            class="field-editor"
            type="datetime-local"
            aria-label="Edit due"
            @keydown.enter.prevent="saveEdit('due')"
            @keydown.esc.prevent="cancelEdit"
          />
          <button type="button" class="mini-btn" @click="saveEdit('due')">✓</button>
          <button type="button" class="mini-btn" @click="cancelEdit">✕</button>
        </template>
        <template v-else>
          <button
            type="button"
            class="prop-value"
            :class="{ empty: detail.task.due === null }"
            @click="startEdit('due')"
          >
            {{ detail.task.due === null ? '—' : formatWhen(detail.task.due) }}
          </button>
        </template>
      </div>

      <div class="prop-row">
        <span class="prop-label">Hidden until</span>
        <template v-if="editingField === 'hiddenUntil'">
          <input
            v-model="draft"
            class="field-editor"
            type="datetime-local"
            aria-label="Edit hidden until"
            @keydown.enter.prevent="saveEdit('hiddenUntil')"
            @keydown.esc.prevent="cancelEdit"
          />
          <button type="button" class="mini-btn" @click="saveEdit('hiddenUntil')">✓</button>
          <button type="button" class="mini-btn" @click="cancelEdit">✕</button>
        </template>
        <template v-else>
          <button
            type="button"
            class="prop-value"
            :class="{ empty: detail.task.hiddenUntil === null }"
            @click="startEdit('hiddenUntil')"
          >
            {{ detail.task.hiddenUntil === null ? '—' : formatWhen(detail.task.hiddenUntil) }}
          </button>
        </template>
      </div>

      <div v-if="detail.task.parentId !== null" class="prop-row">
        <span class="prop-label">Parent</span>
        <button type="button" class="link" @click="navigate(`/ui/tasks/${detail.task.parentId}`)">
          #{{ detail.task.parentId }}
        </button>
      </div>

      <div class="prop-row">
        <span class="prop-label">Tags</span>
        <span class="tag-list">
          <span v-for="tag in detail.task.tags" :key="tag" class="tag-chip">
            {{ tag }}
            <button type="button" class="tag-remove" :aria-label="`Remove tag ${tag}`" @click="removeTag(tag)">×</button>
          </span>
          <span v-if="detail.task.tags.length === 0 && !tagAdding" class="prop-empty">none</span>
          <template v-if="tagAdding">
            <input
              v-model="newTag"
              class="field-editor tag-editor"
              type="text"
              placeholder="tag name"
              aria-label="New tag"
              @keydown.enter.prevent="addTag"
              @keydown.esc.prevent="tagAdding = false"
            />
            <button type="button" class="mini-btn" :disabled="newTag.trim() === ''" @click="addTag">✓</button>
            <button type="button" class="mini-btn" @click="tagAdding = false">✕</button>
          </template>
          <button v-else type="button" class="tag-add" aria-label="Add tag" @click="tagAdding = true">＋ tag</button>
        </span>
      </div>
    </section>

    <section v-if="detail.children.length > 0" class="children">
      <h2>Children</h2>
      <ul>
        <li v-for="child in detail.children" :key="child.id">
          <button type="button" class="link" @click="navigate(`/ui/tasks/${child.id}`)">{{ child.title }}</button>
          <span class="badge" :class="`badge-${child.status}`">{{ child.status }}</span>
        </li>
      </ul>
    </section>

    <section v-if="depRows.length > 0" class="deps">
      <h2>Dependencies (read-only)</h2>
      <ul>
        <li v-for="dep in depRows" :key="dep!.id">
          <button type="button" class="link" @click="navigate(`/ui/tasks/${dep!.id}`)">{{ dep!.title }}</button>
          <span class="badge" :class="`badge-${dep!.status}`">{{ dep!.status }}</span>
          <span v-if="dep!.blocked" class="badge badge-blocked">blocked</span>
        </li>
      </ul>
    </section>

    <section v-if="detail.intervals.length > 0 || detail.totalActiveMs > 0" class="intervals">
      <h2>Intervals</h2>
      <ul>
        <li v-for="interval in detail.intervals" :key="interval.id">
          {{ formatInterval(interval.startedAt, interval.endedAt) }}
        </li>
      </ul>
      <p class="meta">total active: {{ formatTotal(detail.totalActiveMs) }}</p>
    </section>

    <section class="annotations">
      <h2>Annotations</h2>
      <p v-if="detail.annotations.length === 0" class="meta">No annotations yet.</p>
      <ul>
        <li v-for="annotation in detail.annotations" :key="annotation.id">
          <blockquote>{{ annotation.body }}</blockquote>
          <p class="meta">
            <span class="actor-chip" :class="`actor-${annotation.actor.kind}`">{{ actorLabel(annotation.actor) }}</span>
            <span :title="formatWhen(annotation.createdAt)">{{ timeAgo(annotation.createdAt) }}</span>
          </p>
        </li>
      </ul>
      <form class="annotate-form" @submit.prevent="submitAnnotation">
        <textarea v-model="annotationDraft" placeholder="Add an annotation…" aria-label="New annotation" />
        <button type="submit" :disabled="annotationDraft.trim() === ''">Annotate</button>
      </form>
    </section>

    <section class="changes">
      <h2>History <span class="meta">({{ changes.length }} of {{ changesTotal }})</span></h2>
      <p v-if="changes.length === 0" class="meta">No changes recorded yet.</p>
      <ul class="timeline">
        <li v-for="change in changes" :key="change.id" class="change-row">
          <span class="timeline-dot" :class="`actor-${change.actor.kind}`" />
          <div class="change-body">
            <div class="change-head">
              <span class="actor-chip" :class="`actor-${change.actor.kind}`">{{ actorLabel(change.actor) }}</span>
              <span class="change-time" :title="formatWhen(change.createdAt)">{{ timeAgo(change.createdAt) }}</span>
            </div>
            <p v-if="createSummary(change).length > 0" class="change-created">
              Created
              <span v-for="entry in createSummary(change)" :key="entry.field" class="created-chip">
                {{ entry.field }}: {{ entry.value }}
              </span>
            </p>
            <div v-for="entry in diffEntries(change)" :key="entry.field" class="diff-entry">
              <span class="diff-field">{{ entry.field }}</span>
              <span class="diff-before">{{ entry.before }}</span>
              <span class="diff-arrow">→</span>
              <span class="diff-after">{{ entry.after }}</span>
            </div>
          </div>
        </li>
      </ul>
      <button
        v-if="changes.length < changesTotal"
        type="button"
        class="load-more"
        :disabled="changesLoading"
        @click="loadChangesPage()"
      >
        Load {{ Math.min(100, changesTotal - changes.length) }} older
      </button>
    </section>
  </article>

  <p v-else-if="error">{{ error }}</p>
  <p v-else class="meta">Loading…</p>
</template>
