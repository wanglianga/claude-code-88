<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import type { StaffUser, Ticket } from '../types';
import { TICKET_STATUS, TICKET_TYPES, fen, fmtTime, ROLE_LABEL } from '../utils';
import { ok, err } from '../toast';
import Modal from '../components/Modal.vue';

const auth = useAuthStore();
const tickets = ref<Ticket[]>([]);
const filter = ref('all');
const detail = ref<Ticket | null>(null);
const staffUsers = ref<StaffUser[]>([]);
const assignTo = ref<number>(0);
const noteText = ref('');
const resolveText = ref('');

// 居民新建工单（非订单类）
const createOpen = ref(false);
const createType = ref('noise');
const createDesc = ref('');
const CREATE_OPTIONS = [
  { v: 'noise', t: '噪声投诉' },
  { v: 'dispute', t: '物业纠纷' },
  { v: 'device_fault', t: '设备故障' },
  { v: 'other', t: '其他问题' },
];

const isStaff = computed(() => ['service', 'cleaner', 'maintenance', 'property'].includes(auth.user?.role || ''));
const canManage = computed(() => ['service', 'property'].includes(auth.user?.role || ''));

const FILTERS = [
  { v: 'all', t: '全部' },
  { v: 'open', t: '待处理' },
  { v: 'processing', t: '处理中' },
  { v: 'resolved', t: '已解决' },
  { v: 'closed', t: '已关闭' },
];

async function load() {
  const status = filter.value === 'all' ? 'all' : filter.value === 'processing' ? 'processing' : filter.value;
  const query = status === 'all' ? '' : `?status=${status}`;
  let list = await api.get<Ticket[]>(`/api/tickets${query}`);
  if (filter.value === 'processing') {
    // processing 视图包含 assigned
    const assigned = await api.get<Ticket[]>('/api/tickets?status=assigned');
    list = [...list, ...assigned];
  }
  tickets.value = list;
}

async function openDetail(t: Ticket) {
  detail.value = await api.get<Ticket>(`/api/tickets/${t.id}`);
  noteText.value = '';
  resolveText.value = '';
  if (canManage.value && !staffUsers.value.length) {
    staffUsers.value = await api.get<StaffUser[]>('/api/staff/users');
  }
}

async function claim() {
  if (!detail.value) return;
  await api.post(`/api/tickets/${detail.value.id}/claim`);
  ok('已接单，状态更新为处理中');
  await openDetail(detail.value);
  await load();
}

async function assign() {
  if (!detail.value || !assignTo.value) return err('请选择处理人');
  await api.post(`/api/tickets/${detail.value.id}/assign`, { user_id: assignTo.value });
  ok('已指派');
  await openDetail(detail.value);
  await load();
}

async function addNote() {
  if (!detail.value || !noteText.value.trim()) return;
  await api.post(`/api/tickets/${detail.value.id}/note`, { note: noteText.value });
  noteText.value = '';
  await openDetail(detail.value);
}

async function resolve() {
  if (!detail.value) return;
  try {
    await api.post(`/api/tickets/${detail.value.id}/resolve`, { resolution: resolveText.value });
    ok('工单已解决');
    await openDetail(detail.value);
    await load();
  } catch (e: any) { err(e.message); }
}

async function close() {
  if (!detail.value) return;
  await api.post(`/api/tickets/${detail.value.id}/close`);
  ok('工单已关闭归档');
  detail.value = null;
  await load();
}

async function approveRefund() {
  if (!detail.value?.refund) return;
  try {
    const r = await api.post<{ message?: string }>(`/api/refunds/${detail.value.refund.id}/approve`);
    ok(r.message || '退款已批准并原路退回');
    await openDetail(detail.value);
    await load();
  } catch (e: any) { err(e.message); }
}

async function rejectRefund() {
  if (!detail.value?.refund) return;
  const note = prompt('驳回原因（可选）') || '';
  try {
    await toReject(note);
  } catch (e: any) { err(e.message); }
}
async function toReject(note: string) {
  await api.post(`/api/refunds/${detail.value!.refund!.id}/reject`, { note });
  ok('已驳回退款');
  await openDetail(detail.value!);
  await load();
}

async function unlock() {
  if (!detail.value?.device_id) return;
  try {
    const r = await api.post<{ message: string }>(`/api/devices/${detail.value.device_id}/unlock`);
    ok(r.message);
    await openDetail(detail.value);
    await load();
  } catch (e: any) { err(e.message); }
}

async function createTicket() {
  try {
    await api.post('/api/tickets', { type: createType.value, description: createDesc.value });
    ok('工单已提交');
    createOpen.value = false;
    createDesc.value = '';
    await load();
  } catch (e: any) { err(e.message); }
}

onMounted(load);
</script>

<template>
  <div class="container">
    <div class="spread">
      <div class="tabs" style="margin:0">
        <div v-for="f in FILTERS" :key="f.v" class="tab" :class="{ active: filter === f.v }" @click="filter = f.v; load()">{{ f.t }}</div>
      </div>
      <button v-if="auth.user?.role === 'resident'" class="btn btn-primary" @click="createOpen = true">＋ 新建工单</button>
    </div>

    <div class="grid grid-2 mt16">
      <div v-for="t in tickets" :key="t.id" class="card" style="cursor:pointer" @click="openDetail(t)">
        <div class="spread">
          <b>{{ t.title }}</b>
          <span class="badge" :class="TICKET_STATUS[t.status]?.cls">{{ TICKET_STATUS[t.status]?.label }}</span>
        </div>
        <div class="row mt8">
          <span class="badge soft">{{ TICKET_TYPES[t.type] || t.type }}</span>
          <span v-if="t.priority === 'high'" class="badge st-fault">高优先级</span>
          <span v-if="t.device_code" class="badge soft">设备 {{ t.device_code }}</span>
          <span v-if="t.site_name" class="badge soft">{{ t.site_name }}</span>
        </div>
        <p class="muted mt8" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ t.description || '—' }}</p>
        <div class="meta-line mt8">
          <span>{{ t.raised_by_name || '系统' }} · {{ fmtTime(t.created_at) }}</span>
          <span v-if="t.assigned_to_name">处理人：{{ t.assigned_to_name }}</span>
          <span v-else>待接单</span>
        </div>
      </div>
    </div>
    <div v-if="!tickets.length" class="empty">暂无工单</div>

    <!-- 工单详情 -->
    <Modal v-if="detail" :title="`工单 ${detail.ticket_no}`" wide @close="detail = null">
      <div class="row">
        <span class="badge" :class="TICKET_STATUS[detail.status]?.cls">{{ TICKET_STATUS[detail.status]?.label }}</span>
        <span class="badge soft">{{ TICKET_TYPES[detail.type] || detail.type }}</span>
        <span v-if="detail.priority === 'high'" class="badge st-fault">高优先级</span>
      </div>
      <h4 class="mt12">{{ detail.title }}</h4>
      <p class="muted mt8">{{ detail.description || '无补充描述' }}</p>

      <div class="grid grid-3 mt12">
        <div v-if="detail.order_no" class="device-now"><span class="muted">关联订单</span><b>{{ detail.order_no }}</b></div>
        <div v-if="detail.device_code" class="device-now"><span class="muted">关联设备</span><b>{{ detail.device_code }}</b></div>
        <div v-if="detail.site_name" class="device-now"><span class="muted">门店</span><b>{{ detail.site_name }}</b></div>
      </div>

      <!-- 退款审批 -->
      <div v-if="detail.refund" class="alert warn mt12">
        💰 退款申请：{{ fen(detail.refund.amount_cents) }} · {{ detail.refund.reason || '用户申请' }} ·
        状态：{{ { requested: '待审核', paid: '已退款', rejected: '已驳回', approved: '已批准' }[detail.refund.status] }}
      </div>
      <div v-if="detail.refund?.status === 'requested' && canManage" class="row mt8">
        <button class="btn btn-green btn-sm" @click="approveRefund">✅ 批准退款</button>
        <button class="btn btn-red btn-sm" @click="rejectRefund">❌ 驳回</button>
      </div>

      <!-- 时间线 -->
      <div class="section-title">处理时间线</div>
      <div class="timeline">
        <div v-for="e in detail.events" :key="e.id" class="tl-item">
          <div class="tl-dot"></div>
          <div class="tl-body">
            <span class="who">{{ e.actor_name }}</span>
            <span class="when"> · {{ fmtTime(e.created_at) }}</span>
            <div>{{ e.note }}</div>
          </div>
        </div>
      </div>

      <!-- 操作区 -->
      <div v-if="!['resolved', 'closed'].includes(detail.status)">
        <div class="section-title">处理操作</div>
        <div class="row">
          <button v-if="isStaff" class="btn btn-primary btn-sm" @click="claim">🙋 我来处理</button>
          <button v-if="detail.type === 'door_stuck' && ['maintenance', 'service', 'property'].includes(auth.user?.role || '')"
                  class="btn btn-green btn-sm" @click="unlock">🔓 远程开锁</button>
        </div>
        <div v-if="canManage" class="row mt8">
          <select class="select" style="max-width:220px" v-model.number="assignTo">
            <option :value="0" disabled>选择指派人员</option>
            <option v-for="s in staffUsers" :key="s.id" :value="s.id">{{ s.name }}（{{ ROLE_LABEL[s.role] }}）</option>
          </select>
          <button class="btn btn-outline btn-sm" @click="assign">指派</button>
        </div>
        <div class="row mt8">
          <input class="input" style="flex:1" v-model="noteText" placeholder="添加处理备注（如：已联系用户、已现场核实）" />
          <button class="btn btn-ghost btn-sm" @click="addNote">备注</button>
        </div>
        <div class="row mt8" v-if="isStaff">
          <input class="input" style="flex:1" v-model="resolveText" placeholder="解决方案（如：已补液 / 已维修 / 已协商）" />
          <button class="btn btn-green btn-sm" @click="resolve">✔ 标记解决</button>
        </div>
      </div>
      <div v-if="detail.status === 'resolved' && (canManage || detail.raised_by === auth.user?.id)" class="mt12">
        <button class="btn btn-ghost btn-sm" @click="close">关闭归档</button>
      </div>
      <div v-if="detail.resolution" class="alert info mt12">处理结论：{{ detail.resolution }}</div>
    </Modal>

    <!-- 居民新建工单 -->
    <Modal v-if="createOpen" title="新建工单" @close="createOpen = false">
      <div class="field">
        <label>类型</label>
        <select class="select" v-model="createType">
          <option v-for="o in CREATE_OPTIONS" :key="o.v" :value="o.v">{{ o.t }}</option>
        </select>
      </div>
      <div class="field">
        <label>描述</label>
        <textarea class="textarea" v-model="createDesc" placeholder="请描述问题，如：23 点后仍有设备运行噪声影响休息"></textarea>
      </div>
      <button class="btn btn-primary btn-block" @click="createTicket">提交</button>
    </Modal>
  </div>
</template>
