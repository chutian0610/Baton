<script setup lang="ts">
import { computed, inject, onUnmounted, ref, watch } from 'vue';
import { injectApi } from '../api';
import { errorMessage, isoToLocal, localToIso, parseTags, timeAgo } from '../form';
import { navigate } from '../router';
import { legalTargets } from '../transitions';
import type { Actor, Change, TaskDetailPayload, TaskStatus } from '../types';

/**
 * The task detail panel (v0.3 T5 audit window + T6 writes, redesigned in the
 * v0.3 review pass): non-empty properties only, tinted machine-legal
 * transition pills, the annotation timeline, intervals, read-only
 * dependencies, and the FULL change log as a structured timeline — Actor
 * chips, relative stamps, per-field diff rows with no-op entries cut, and
 * create rows summarized instead of dumping every field. The panel re-polls
 * on an interval (paused while hidden) so an agent mutating the task cannot
 * leave the audit stale; structural editing (reparent, dependencies, project
 * re-binding) is deliberately absent — agent work over MCP (ADR-0006).
 */

const props = withDefaults(defineProps<{ id: number; pollMs?: number }>(), { pollMs: 5000 });

const emit = defineEmits<{ mutated: [] }>();

const api = injectApi();

const detail = ref<TaskDetailPayload | null>(null);
const error = ref<string | null>(null);
const actionError = ref<string | null>(null);

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

// Polling: the audit window follows the store (agents mutate while the
// human watches); quiet reloads keep the current view until fresh data lands.
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

/** Runs one write, reloads the detail, and tells the parent to refresh its list. */
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

// ------------------------------------------------------------ transitions

const targets = computed<TaskStatus[]>(() => (detail.value ? legalTargets(detail.value.task.status) : []));

function transitionTo(target: TaskStatus): void {
  void act(() => api.updateTask(props.id, { status: target }));
}

// ------------------------------------------------------------ field editing

const editing = ref(false);
const editTitle = ref('');
const editTags = ref('');
const editPriority = ref('');
const editEffort = ref('');
const editDue = ref('');
const editHiddenUntil = ref('');

function startEditing(): void {
  const task = detail.value!.task;
  editTitle.value = task.title;
  editTags.value = task.tags.join(', ');
  editPriority.value = task.priority ?? '';
  editEffort.value = task.effort ?? '';
  editDue.value = isoToLocal(task.due);
  editHiddenUntil.value = isoToLocal(task.hiddenUntil);
  editing.value = true;
}

function saveEdits(): void {
  const body: Record<string, unknown> = {
    title: editTitle.value.trim(),
    tags: parseTags(editTags.value),
    priority: editPriority.value === '' ? null : editPriority.value,
    effort: editEffort.value === '' ? null : editEffort.value,
  };
  body.due = localToIso(editDue.value);
  body.hiddenUntil = localToIso(editHiddenUntil.value);
  void act(async () => {
    await api.updateTask(props.id, body);
    editing.value = false;
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

/** The meaningful diff rows: no-op entries (unchanged fields) are cut. */
function diffEntries(change: Change): DiffEntry[] {
  return Object.entries(change.diff)
    .filter(([field, delta]) => field === 'title' || JSON.stringify(delta.before) !== JSON.stringify(delta.after))
    .map(([field, delta]) => ({
      field: humanField(field),
      before: formatValue(delta.before),
      after: formatValue(delta.after),
    }));
}

/** A create row: every field moved from nothing — summarize instead of dumping. */
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

async function loadDep(id: number): Promise<{ id: number; title: string; status: string; blocked: boolean } | null> {
  try {
    const payload = await api.getTask(id);
    return payload.task;
  } catch {
    return null; // a deleted world has no deleted tasks — deps always resolve, but stay safe
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
    startPolling();
  },
  { immediate: true },
);

onUnmounted(stopPolling);
</script>

<template>
  <article v-if="detail">
    <h1>{{ detail.task.title }}</h1>
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
      <button v-if="!editing" type="button" class="edit-toggle" @click="startEditing">✎ Edit</button>
    </section>

    <form v-if="editing" class="edit-form" @submit.prevent="saveEdits">
      <input v-model="editTitle" type="text" aria-label="Title" />
      <input v-model="editTags" type="text" placeholder="tags, comma-separated" aria-label="Tags" />
      <select v-model="editPriority" aria-label="Priority">
        <option value="">no priority</option>
        <option value="H">H</option>
        <option value="M">M</option>
        <option value="L">L</option>
      </select>
      <input v-model="editEffort" type="text" placeholder="effort" aria-label="Effort" />
      <input v-model="editDue" type="datetime-local" aria-label="Due" />
      <input v-model="editHiddenUntil" type="datetime-local" aria-label="Hidden until" />
      <button type="submit">Save</button>
      <button type="button" @click="editing = false">Cancel</button>
    </form>

    <section class="fields">
      <dl>
        <dt>Project</dt>
        <dd>{{ detail.task.projectName ?? 'Unbound' }}</dd>
        <template v-if="detail.task.priority !== null">
          <dt>Priority</dt>
          <dd>{{ detail.task.priority }}</dd>
        </template>
        <template v-if="detail.task.effort !== null">
          <dt>Effort</dt>
          <dd>{{ detail.task.effort }}</dd>
        </template>
        <template v-if="detail.task.due !== null">
          <dt>Due</dt>
          <dd>{{ formatWhen(detail.task.due) }}</dd>
        </template>
        <template v-if="detail.task.hiddenUntil !== null">
          <dt>Hidden until</dt>
          <dd>{{ formatWhen(detail.task.hiddenUntil) }}</dd>
        </template>
        <template v-if="detail.task.parentId !== null">
          <dt>Parent</dt>
          <dd>
            <button type="button" class="link" @click="navigate(`/ui/tasks/${detail.task.parentId}`)">
              #{{ detail.task.parentId }}
            </button>
          </dd>
        </template>
        <template v-if="detail.task.tags.length > 0">
          <dt>Tags</dt>
          <dd>
            <span v-for="tag in detail.task.tags" :key="tag" class="tag-chip">{{ tag }}</span>
          </dd>
        </template>
      </dl>
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
      <p v-if="detail.intervals.length === 0">Never active yet.</p>
      <ul>
        <li v-for="interval in detail.intervals" :key="interval.id">
          {{ formatInterval(interval.startedAt, interval.endedAt) }}
        </li>
      </ul>
      <p v-if="detail.totalActiveMs > 0" class="meta">total active: {{ formatTotal(detail.totalActiveMs) }}</p>
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
