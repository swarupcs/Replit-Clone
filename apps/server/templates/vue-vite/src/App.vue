<script setup>
import { ref } from "vue";

const count = ref(0);
</script>

<template>
  <main>
    <h1>Hello from your Vue playground</h1>
    <p>Edit <code>src/App.vue</code> and save — the page updates itself.</p>
    <button @click="count++">Clicked {{ count }} times</button>
  </main>
</template>
