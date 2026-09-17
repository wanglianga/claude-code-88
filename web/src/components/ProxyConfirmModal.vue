<script setup lang="ts">
import { ref } from 'vue';
import { api } from '../api';
import type { ProxyPickup } from '../types';
import { ok, err } from '../toast';
import Modal from './Modal.vue';

const props = defineProps<{ task: ProxyPickup }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>();

const bagNo = ref('');
const scanPayload = ref('');
const scanning = ref(false);
const submitting = ref(false);

/** 模拟用户到存放柜前扫码（真实场景为扫柜门二维码获得） */
async function mockScan() {
  scanning.value = true;
  try {
    const r = await api.get<{ payload: string; cabinet_no: string }>(`/api/proxy-pickups/${props.task.id}/scan-code`);
    scanPayload.value = r.payload;
    ok(`已扫描 ${r.cabinet_no} 柜二维码`);
  } catch (e: any) {
    err(e.message);
  } finally {
    scanning.value = false;
  }
}

async function submit() {
  submitting.value = true;
  try {
    const r = await api.post<{ message: string }>(`/api/proxy-pickups/${props.task.id}/confirm`, {
      bag_no: bagNo.value,
      scan_payload: scanPayload.value,
    });
    ok(r.message);
    emit('done');
    emit('close');
  } catch (e: any) {
    err(e.message);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Modal :title="`取回确认 · 封袋 ${task.bag_no}`" @close="emit('close')">
    <div class="alert info">
      您的衣物由保洁 <b>{{ task.cleaner_name }}</b> 代取封袋，存放于 <b>{{ task.cabinet_no }} 柜</b>。
      取回时请：① 核对封袋上的编号；② 到柜前扫码确认。
    </div>
    <div class="field mt12">
      <label>① 核对封袋编号（封袋上印刷的编号）</label>
      <input class="input" v-model="bagNo" :placeholder="`请输入封袋编号，如 ${task.bag_no}`" />
    </div>
    <div class="field">
      <label>② 扫码确认（扫描 {{ task.cabinet_no }} 柜门二维码）</label>
      <div class="row">
        <input class="input" style="flex:1" v-model="scanPayload" placeholder="扫码结果将自动填入" readonly />
        <button class="btn btn-outline" :disabled="scanning" @click="mockScan">📷 模拟扫码</button>
      </div>
    </div>
    <button class="btn btn-green btn-block" :disabled="submitting || !bagNo || !scanPayload" @click="submit">
      {{ submitting ? '确认中...' : '核对无误，确认取回' }}
    </button>
  </Modal>
</template>
