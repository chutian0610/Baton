<script setup lang="ts">
import { computed, inject, onUnmounted, ref, watch } from 'vue';
import { injectApi } from '../api';
import { errorMessage, isoToLocal, localToIso, parseTags } from '../form';
import { navigate } from '../router';
import { legalTargets } from '../transitions';
import type { Actor, Change, TaskDetailPayload, TaskStatus } from '../types';

/**
 * The task detail page (v0.3 T5 audit window + T6 writes, hardened in the
 * v0.3 review): every stored field, the append-only annotation timeline,
 * the recorded intervals, dependencies read-only with their blocked state,
 * and the FULL change log (paged) with Actor attribution — plus the human's
 * write surface: machine-legal status transitions, field editing, and
 * annotations. The page re-polls on an interval (paused while hidden) so an
 * agent mutating the task cannot leave the audit window stale; structural
 * editing (reparent, dependencies, project re-binding) is deliberately
 * absent — agent work over MCP (ADR-0006).
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

function formatActor(actor: Actor): string {
  return actor.kind === 'mcp' ? `mcp (${actor.clientName ?? 'unknown'})` : actor.kind;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatInterval(startedAt: string, endedAt: string | null): string {
  const start = formatWhen(startedAt);
  return endedAt === null ? `${start} — active now` : `${start} — ${formatWhen(endedAt)}`;
}

/** Change rows without a field diff (the create row) describe themselves by the diff instead. */
function describeDiff(change: Change): string {
  const parts = Object.entries(change.diff).map(
    ([field, delta]) => `${field}: ${JSON.stringify(delta.before)} → ${JSON.stringify(delta.after)}`,
  );
  return parts.length === 0 ? '(created)' : parts.join(', ');
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
</script>

<template>
  <article v-if="detail">
    <h1>{{ detail.task.title }}</h1>
    <p>
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
        class="transition"
        @click="transitionTo(target)"
      >
        → {{ target }}
      </button>
      <button v-if="!editing" type="button" @click="startEditing">Edit fields</button>
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
        <dt>Priority</dt>
        <dd>{{ detail.task.priority ?? '—' }}</dd>
        <dt>Effort</dt>
        <dd>{{ detail.task.effort ?? '—' }}</dd>
        <dt>Due</dt>
        <dd>{{ detail.task.due === null ? '—' : formatWhen(detail.task.due) }}</dd>
        <dt>Hidden until</dt>
        <dd>{{ detail.task.hiddenUntil === null ? '—' : formatWhen(detail.task.hiddenUntil) }}</dd>
        <dt>Parent</dt>
        <dd>
          <button v-if="detail.task.parentId !== null" type="button" class="link" @click="navigate(`/ui/tasks/${detail.task.parentId}`)">
            #{{ detail.task.parentId }}
          </button>
          <span v-else>—</span>
        </dd>
        <dt>Tags</dt>
        <dd>
          <span v-for="tag in detail.task.tags" :key="tag" class="badge badge-soft">{{ tag }}</span>
          <span v-if="detail.task.tags.length === 0">—</span>
        </dd>
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

    <section class="intervals">
      <h2>Intervals</h2>
      <p v-if="detail.intervals.length === 0">Never active yet.</p>
      <ul>
        <li v-for="interval in detail.intervals" :key="interval.id">
          {{ formatInterval(interval.startedAt, interval.endedAt) }}
        </li>
      </ul>
      <p class="meta">total active: {{ Math.round(detail.totalActiveMs / 1000) }}s</p>
    </section>

    <section class="annotations">
      <h2>Annotations</h2>
      <p v-if="detail.annotations.length === 0">No annotations.</p>
      <ul>
        <li v-for="annotation in detail.annotations" :key="annotation.id">
          <blockquote>{{ annotation.body }}</blockquote>
          <p class="meta">{{ formatWhen(annotation.createdAt) }} · {{ formatActor(annotation.actor) }}</p>
        </li>
      </ul>
      <form class="annotate-form" @submit.prevent="submitAnnotation">
        <textarea v-model="annotationDraft" placeholder="Add an annotation…" aria-label="New annotation" />
        <button type="submit" :disabled="annotationDraft.trim() === ''">Annotate</button>
      </form>
    </section>

    <section class="changes">
      <h2>Change log <span class="meta">({{ changes.length }} of {{ changesTotal }})</span></h2>
      <ul>
        <li v-for="change in changes" :key="change.id">
          {{ formatWhen(change.createdAt) }} · {{ formatActor(change.actor) }} · {{ describeDiff(change) }}
        </li>
      </ul>
      <button
        v-if="changes.length < changesTotal"
        type="button"
        :disabled="changesLoading"
        @click="loadChangesPage()"
      >
        Load {{ Math.min(100, changesTotal - changes.length) }} older
      </button>
    </section>
  </article>

  <p v-else-if="error">{{ error }}</p>
  <p v-else>Loading…</p>
</template>
