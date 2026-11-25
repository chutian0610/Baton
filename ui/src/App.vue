<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import ProjectPicker from './components/ProjectPicker.vue';
import { createStore } from './store';

// T3 wiring: the read spine starts polling on mount and stops on unmount.
// The list views (T4) replace the placeholder main below.
const store = createStore();

onMounted(() => store.start());
onUnmounted(() => store.stop());
</script>

<template>
  <header>
    <ProjectPicker :scope="store.state.scope" :projects="store.state.projects" @change="store.setScope" />
    <span v-if="store.state.error" class="error">{{ store.state.error }}</span>
  </header>
  <main>
    <p>{{ store.list.value.length }} task(s) in view.</p>
  </main>
</template>
