<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, provide, ref } from 'vue';
import NewTaskForm from './components/NewTaskForm.vue';
import Sidebar from './components/Sidebar.vue';
import TaskDetail from './components/TaskDetail.vue';
import TaskTree from './components/TaskTree.vue';
import VisibilityToggles from './components/VisibilityToggles.vue';
import { createHttpApi } from './api';
import { createStore } from './store';
import { currentPath, navigate, onPathChange, parseRoute, type Route } from './router';

/**
 * The shell (v0.3 redesign): sidebar (views + projects) / main list / detail
 * panel. The store is provided so tree rows and the panel mutate shared data
 * without emit chains; the api transport is injectable for tests. Deep links
 * (/ui/tasks/:id) open the panel directly over the list.
 */

const injectedStore = inject<ReturnType<typeof createStore> | undefined>('store', undefined);
const apiBase = inject<string>('apiBase', '');
const detailPollMs = inject<number | undefined>('detailPollMs', undefined);
const store = injectedStore ?? createStore({ api: createHttpApi(apiBase) });
provide('store', store);

// The route parses from the URL at setup — deep links open the panel on
// first paint; pushState/popstate keep in-app navigation in sync.
const route = ref<Route>(parseRoute(currentPath()));
const unsubscribe = onPathChange((path) => {
  route.value = parseRoute(path);
});

onMounted(() => store.start());
onUnmounted(() => {
  store.stop();
  unsubscribe();
});

const detailId = computed(() => (route.value.name === 'task' ? route.value.id : null));
</script>

<template>
  <div class="layout">
    <Sidebar
      :view="store.state.view"
      :scope="store.state.scope"
      :counts="store.counts.value"
      :projects="store.state.projects"
      @set-view="store.setView"
      @set-scope="store.setScope"
    />

    <main class="main">
      <div class="list-toolbar">
        <VisibilityToggles
          :visibility="store.state.visibility"
          :tasks="store.state.tasks"
          :scope="store.state.scope"
          :now="store.state.lastSync ?? 0"
          @change="store.setVisibility"
        />
      </div>

      <NewTaskForm :scope="store.state.scope" @created="store.refresh()" />

      <main class="list">
        <p v-if="store.state.loading && store.state.lastSync === null" class="list-state">Loading…</p>
        <p v-else-if="store.tree.value.length === 0" class="list-state">No tasks in view.</p>
        <TaskTree v-else :nodes="store.tree.value" :now="store.state.lastSync ?? 0" />
      </main>
    </main>

    <aside v-if="detailId !== null" class="detail-panel">
      <div class="panel-head">
        <button type="button" class="panel-close" aria-label="Close task detail" @click="navigate('/ui')">✕</button>
      </div>
      <div class="panel-body">
        <TaskDetail :id="detailId" :poll-ms="detailPollMs ?? 5000" @mutated="store.refresh()" />
      </div>
    </aside>
  </div>
</template>
