<script setup lang="ts">
import { inject, ref, watch } from 'vue';
import { createHttpApi, type Api } from '../api';
import { navigate } from '../router';
import type { TaskDetailPayload } from '../types';

/**
 * The task detail page (v0.3 T5) — the audit window: every stored field,
 * the append-only annotation timeline, the recorded intervals, dependencies
 * read-only with their blocked state, and the change log with Actor
 * attribution. Reads only; writes land with T6.
 */

const props = defineProps<{ id: number }>();

const apiBase = inject<string>('apiBase', '');
const api: Api = createHttpApi(apiBase);

const detail = ref<TaskDetailPayload | null>(null);
const error = ref<string | null>(null);

async function load(id: number): Promise<void> {
  detail.value = null;
  error.value = null;
  try {
    detail.value = await api.getTask(id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

watch(() => props.id, (id) => void load(id), { immediate: true });

function formatActor(actor: unknown): string {
  const a = actor as { kind: string; clientName?: string; clientVersion?: string };
  if (a.kind === 'mcp') {
    return `mcp (${a.clientName ?? 'unknown'})`;
  }
  return a.kind;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatInterval(startedAt: string, endedAt: string | null): string {
  const start = formatWhen(startedAt);
  return endedAt === null ? `${start} — active now` : `${start} — ${formatWhen(endedAt)}`;
}

/** Change rows without a field diff (the create row) describe themselves by the diff instead. */
function describeDiff(change: { diff: Record<string, { before: unknown; after: unknown }> }): string {
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
    </section>

    <section class="changes">
      <h2>Change log <span class="meta">(last {{ detail.recentChanges.length }})</span></h2>
      <ul>
        <li v-for="change in detail.recentChanges" :key="change.id">
          {{ formatWhen(change.createdAt) }} · {{ formatActor(change.actor) }} · {{ describeDiff(change) }}
        </li>
      </ul>
    </section>
  </article>

  <p v-else-if="error">{{ error }}</p>
  <p v-else>Loading…</p>
</template>
