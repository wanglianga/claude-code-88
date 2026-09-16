<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';
import type { Device, Ticket } from '../types';
import { DEVICE_STATUS, fen, fmtTime } from '../utils';
import { ok, err } from '../toast';
import Modal from '../components/Modal.vue';

type FaultDevice = Device & { site_name?: string };

const devices = ref<FaultDevice[]>([]);
const repairs = ref<any[]>([]);
const tickets = ref<Ticket[]>([]);

// 维修登记
const repairOpen = ref(false);
const repairForm = ref({ device_id: 0, ticket_id: 0, description: '', cost_cents: 0 });
const repairDeviceCode = ref('');

async function load() {
  const [b, t] = await Promise.all([
    api.get<{ devices: FaultDevice[]; repairs: any[] }>('/api/maintenance/board'),
    api.get<Ticket[]>('/api/tickets'),
  ]);
  devices.value = b.devices;
  repairs.value = b.repairs;
  tickets.value = t.filter((x) => !['resolved', 'closed'].includes(x.status));
}

async function setStatus(d: FaultDevice, status: string) {
  try {
    await api.put(`/api/devices/${d.id}/status`, { status });
    ok(`设备 ${d.code} 已更新为「${DEVICE_STATUS[status as keyof typeof DEVICE_STATUS].label}」`);
    await load();
  } catch (e: any) { err(e.message); }
}

function openRepair(d: FaultDevice) {
  const t = tickets.value.find((x) => x.device_id === d.id);
  repairForm.value = { device_id: d.id, ticket_id: t?.id || 0, description: '', cost_cents: 0 };
  repairDeviceCode.value = d.code;
  repairOpen.value = true;
}

async function submitRepair() {
  try {
    await api.post('/api/repairs', {
      device_id: repairForm.value.device_id,
      ticket_id: repairForm.value.ticket_id || null,
      description: repairForm.value.description,
      cost_cents: Math.round(repairForm.value.cost_cents * 100) / 1,
    });
    ok('维修已登记，设备恢复空闲');
    repairOpen.value = false;
    await load();
  } catch (e: any) { err(e.message); }
}

async function unlock(d: FaultDevice) {
  try {
    const r = await api.post<{ message: string }>(`/api/devices/${d.id}/unlock`);
    ok(r.message);
  } catch (e: any) { err(e.message); }
}

onMounted(load);
</script>

<template>
  <div class="container">
    <div class="card">
      <div class="card-title">🔧 异常设备 <span class="sub">故障 / 维修中 / 离线</span></div>
      <div v-if="devices.length" class="grid grid-3">
        <div v-for="d in devices" :key="d.id" class="device-card" :class="`st-border-${d.status}`">
          <div class="device-head">
            <div class="device-code">
              <span class="device-icon">{{ d.type === 'washer' ? '🧺' : '🌬️' }}</span>{{ d.code }}
            </div>
            <span class="badge" :class="DEVICE_STATUS[d.status].cls">{{ DEVICE_STATUS[d.status].label }}</span>
          </div>
          <div class="muted">{{ d.site_name }} · {{ d.zone_name }} · {{ d.capacity_kg }}kg</div>
          <div class="row">
            <button class="btn btn-primary btn-sm" @click="openRepair(d)">登记维修</button>
            <button class="btn btn-outline btn-sm" @click="unlock(d)">远程开锁</button>
          </div>
          <div class="row">
            <button v-if="d.status !== 'maintenance'" class="btn btn-ghost btn-sm" @click="setStatus(d, 'maintenance')">设为维修中</button>
            <button v-if="d.status !== 'offline'" class="btn btn-ghost btn-sm" @click="setStatus(d, 'offline')">设为离线</button>
            <button class="btn btn-green btn-sm" @click="setStatus(d, 'idle')">恢复空闲</button>
          </div>
        </div>
      </div>
      <div v-else class="empty">🎉 当前没有异常设备</div>
    </div>

    <div class="card mt16">
      <div class="card-title">待处理工单 <span class="sub">前往「工单」页面查看详情与处理</span></div>
      <table class="table" v-if="tickets.length">
        <thead><tr><th>工单号</th><th>标题</th><th>状态</th><th>时间</th></tr></thead>
        <tbody>
          <tr v-for="t in tickets" :key="t.id">
            <td style="font-weight:700">{{ t.ticket_no }}</td>
            <td>{{ t.title }}</td>
            <td><span class="badge st-queued">{{ t.status }}</span></td>
            <td class="muted">{{ fmtTime(t.created_at) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无待处理工单</div>
    </div>

    <div class="card mt16">
      <div class="card-title">维修档案</div>
      <table class="table" v-if="repairs.length">
        <thead><tr><th>时间</th><th>设备</th><th>内容</th><th>费用</th><th>技师</th></tr></thead>
        <tbody>
          <tr v-for="r in repairs" :key="r.id">
            <td class="muted">{{ fmtTime(r.created_at) }}</td>
            <td style="font-weight:700">{{ r.device_code }}</td>
            <td>{{ r.description }}</td>
            <td>{{ fen(r.cost_cents) }}</td>
            <td>{{ r.technician_name || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无维修记录</div>
    </div>

    <Modal v-if="repairOpen" :title="`登记维修 · ${repairDeviceCode}`" @close="repairOpen = false">
      <div class="field">
        <label>维修内容</label>
        <textarea class="textarea" v-model="repairForm.description" placeholder="如：更换加热管，测试烘干正常"></textarea>
      </div>
      <div class="field">
        <label>维修费用（元）</label>
        <input class="input" type="number" min="0" step="0.01" v-model.number="repairForm.cost_cents" />
      </div>
      <div v-if="repairForm.ticket_id" class="alert info">已关联工单 #{{ repairForm.ticket_id }}，提交后工单自动标记解决</div>
      <button class="btn btn-primary btn-block mt12" @click="submitRepair">提交（设备恢复空闲）</button>
    </Modal>
  </div>
</template>
