<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from 'vue';
import ProjectPicker from './components/ProjectPicker.vue';
import TaskTree from './components/TaskTree.vue';
import ViewTabs from './components/ViewTabs.vue';
import VisibilityToggles from './components/VisibilityToggles.vue';
import { createHttpApi } from './api';
import { createStore } from './store';
import { navigate, onPathChange, parseRoute, type Route } from './router';

// T3 wiring: the read spine starts polling on mount and stops on unmount.
// Injectable for tests: a pre-built store (deterministic refresh awaits) or
// just an api base pointing the transport at a real booted daemon.
// Production provides neither: same-origin transport, fresh store.
const injectedStore = inject<ReturnType<typeof createStore> | undefined>('store', undefined);
const apiBase = inject<string>('apiBase', '');
const store = injectedStore ?? createStore({ api: createHttpApi(apiBase) });

// T4: list views (Open / Today / Blocked, scoped by the picker, with the
// visibility toggles). The task detail route renders fully in T5.
const route = ref<Route>({ name: 'list' });
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
    <main>
      <p v-if="store.state.loading && store.state.lastSync === null">Loading…</p>
      <p v-else-if="store.list.value.length === 0">No tasks in view.</p>
      <TaskTree v-else :tasks="store.list.value" />
    </main>
  </template>

  <template v-else>
    <main>
      <button type="button" @click="navigate('/ui')">← Back</button>
      <p>Task detail for #{{ detailId }} — lands with T5.</p>
    </main>
  </template>
</template>
