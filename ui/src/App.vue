<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from 'vue';
import NewTaskForm from './components/NewTaskForm.vue';
import ProjectPicker from './components/ProjectPicker.vue';
import TaskDetail from './components/TaskDetail.vue';
import TaskTree from './components/TaskTree.vue';
import ViewTabs from './components/ViewTabs.vue';
import VisibilityToggles from './components/VisibilityToggles.vue';
import { createHttpApi } from './api';
import { createStore } from './store';
import { currentPath, navigate, onPathChange, parseRoute, type Route } from './router';

// T3 wiring: the read spine starts polling on mount and stops on unmount.
// Injectable for tests: a pre-built store (deterministic refresh awaits) or
// just an api base pointing the transport at a real booted daemon.
// Production provides neither: same-origin transport, fresh store.
const injectedStore = inject<ReturnType<typeof createStore> | undefined>('store', undefined);
const apiBase = inject<string>('apiBase', '');
const store = injectedStore ?? createStore({ api: createHttpApi(apiBase) });

// T4/T5: the route parses from the URL at setup — deep links (/ui/tasks/:id)
// must render the detail on first paint, not just after pushState/popstate.
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
  <header>
    <ProjectPicker :scope="store.state.scope" :projects="store.state.projects" @change="store.setScope" />
    <span v-if="store.state.error" class="error">{{ store.state.error }}</span>
  </header>

  <template v-if="detailId === null">
    <ViewTabs :view="store.state.view" @change="store.setView" />
    <VisibilityToggles
      :visibility="store.state.visibility"
      :tasks="store.state.tasks"
      :scope="store.state.scope"
      :now="Date.now()"
      @change="store.setVisibility"
    />
    <NewTaskForm :scope="store.state.scope" @created="store.refresh()" />
    <main>
      <p v-if="store.state.loading && store.state.lastSync === null">Loading…</p>
      <p v-else-if="store.list.value.length === 0">No tasks in view.</p>
      <TaskTree v-else :tasks="store.list.value" />
    </main>
  </template>

  <template v-else>
    <main>
      <button type="button" class="back" @click="navigate('/ui')">← Back</button>
      <TaskDetail :id="detailId" @mutated="store.refresh()" />
    </main>
  </template>
</template>
