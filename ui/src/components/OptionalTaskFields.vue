<script setup lang="ts">
/**
 * The optional task fields grid (v0.3 redesign): tags, priority, effort,
 * due, hidden-until — shared verbatim by the quick-add bar and the inline
 * add-subtask form so both capture paths speak the same language.
 * Each model is a plain string; '' means unset.
 */

const tags = defineModel<string>('tags');
const priority = defineModel<string>('priority');
const effort = defineModel<string>('effort');
const due = defineModel<string>('due');
const hiddenUntil = defineModel<string>('hiddenUntil');
</script>

<template>
  <div class="quick-add-fields">
    <label class="qa-field">
      <span>Tags</span>
      <input v-model="tags" type="text" placeholder="comma, separated" aria-label="Tags" />
    </label>
    <label class="qa-field">
      <span>Priority</span>
      <select v-model="priority" aria-label="Priority">
        <option value="">—</option>
        <option value="H">H</option>
        <option value="M">M</option>
        <option value="L">L</option>
      </select>
    </label>
    <label class="qa-field">
      <span>Effort</span>
      <input v-model="effort" type="text" placeholder="e.g. 2h" aria-label="Effort" />
    </label>
    <label class="qa-field">
      <span>Due</span>
      <input v-model="due" type="datetime-local" aria-label="Due" />
    </label>
    <label class="qa-field">
      <span>Hidden until</span>
      <input v-model="hiddenUntil" type="datetime-local" aria-label="Hidden until" />
    </label>
  </div>
</template>
