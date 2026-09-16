<script setup lang="ts">
defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal" :class="{ wide }">
      <div class="modal-head">
        <h3>{{ title }}</h3>
        <button class="modal-close" @click="emit('close')">✕</button>
      </div>
      <slot />
    </div>
  </div>
</template>
