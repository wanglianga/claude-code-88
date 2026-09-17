<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import type { Inspection, LostItem, PickupOrderTask, ProxyPickup, Site } from '../types';
import { fen, fmtTime, remainText, overdueText, LOST_STATUS } from '../utils';
import { ok, err } from '../toast';
import Modal from '../components/Modal.vue';

interface Tasks {
  lowDevices: { id: number; code: string; detergent_level: number; site_name: string }[];
  pickupOrders: PickupOrderTask[];
  auths: { id: number; order_id: number; order_no: string; user_name: string; device_code: string; site_name: string }[];
  proxyStored: { id: number; bag_no: string; cabinet_no: string; keep_until: string; created_at: string; order_no: string; user_name: string; device_code: string; site_name: string }[];
}

const sites = ref<Site[]>([]);
const tasks = ref<Tasks>({ lowDevices: [], pickupOrders: [], auths: [], proxyStored: [] });
const inspections = ref<Inspection[]>([]);
const restocks = ref<any[]>([]);
const lostItems = ref<LostItem[]>([]);
const now = ref(Date.now());
let tickTimer: number | undefined;

// 巡检表单
const form = ref({
  site_id: 0,
  floor_status: '正常',
  filter_status: '正常',
  detergent_status: '正常',
  odor_status: '正常',
  leftover_status: '无',
  camera_status: '正常',
  note: '',
});
const OPTS = ['正常', '异常'];
const OPTS_DET = ['正常', '不足'];
const OPTS_LEFT = ['无', '有遗留'];

// 补货表单
const restockForm = ref({ site_id: 0, item: '洗衣液', quantity: 10, note: '' });

// 代取弹窗（拍照 / 封袋 / 存放柜 / 保洁确认）
const collectOrder = ref<{ id: number; order_no: string; device_code?: string; user_name?: string } | null>(null);
const collectAuthId = ref<number | null>(null);
const collectForm = ref({ photo_note: '', bag_no: '', cabinet_no: 'A-01', confirmed: false });
const CABINETS = ['A-01', 'A-02', 'A-03', 'A-04', 'B-01', 'B-02', 'B-03', 'B-04'];

async function load() {
  const [s, t, i, r, l] = await Promise.all([
    api.get<Site[]>('/api/sites'),
    api.get<Tasks>('/api/cleaner/tasks'),
    api.get<Inspection[]>('/api/inspections'),
    api.get<any[]>('/api/restocks'),
    api.get<LostItem[]>('/api/lost-items'),
  ]);
  sites.value = s;
  tasks.value = t;
  inspections.value = i;
  restocks.value = r;
  lostItems.value = l;
  if (!form.value.site_id && s.length) form.value.site_id = s[0].id;
  if (!restockForm.value.site_id && s.length) restockForm.value.site_id = s[0].id;
}

async function submitInspection() {
  try {
    await api.post('/api/inspections', form.value);
    ok('巡检记录已提交');
    form.value.note = '';
    await load();
  } catch (e: any) { err(e.message); }
}

async function submitRestock() {
  try {
    await api.post('/api/restocks', restockForm.value);
    ok('补货已登记');
    await load();
  } catch (e: any) { err(e.message); }
}

async function refillDevice(d: { id: number; code: string; site_name: string }) {
  try {
    const site = sites.value.find((s) => s.name === d.site_name);
    await api.post('/api/restocks', { site_id: site?.id, item: '洗衣液', quantity: 1, device_id: d.id, note: `${d.code} 补满` });
    ok(`${d.code} 洗衣液已补满`);
    await load();
  } catch (e: any) { err(e.message); }
}

/** 打开代取弹窗：超时强制代取（order）或用户授权代取（order + authId） */
async function openCollect(o: { id: number; order_no: string; device_code?: string; user_name?: string }, authId: number | null = null) {
  collectOrder.value = o;
  collectAuthId.value = authId;
  collectForm.value = { photo_note: '', bag_no: '', cabinet_no: 'A-01', confirmed: false };
  try {
    const r = await api.get<{ bag_no: string }>('/api/proxy-pickups/next-bag-no');
    collectForm.value.bag_no = r.bag_no;
  } catch { /* 编号可手填 */ }
}

function mockPhoto() {
  const o = collectOrder.value;
  collectForm.value.photo_note = `现场照片：设备 ${o?.device_code ?? ''} 桶内衣物一袋，已拍照留档并装入封袋`;
}

async function submitCollect() {
  const o = collectOrder.value;
  if (!o) return;
  try {
    const r = await api.post<{ message: string }>(`/api/orders/${o.id}/proxy-collect`, {
      photo_note: collectForm.value.photo_note,
      bag_no: collectForm.value.bag_no,
      cabinet_no: collectForm.value.cabinet_no,
      confirmed: collectForm.value.confirmed,
      auth_id: collectAuthId.value,
    });
    ok(r.message);
    collectOrder.value = null;
    await load();
  } catch (e: any) { err(e.message); }
}

async function returnItem(l: LostItem) {
  try {
    await api.post(`/api/lost-items/${l.id}/return`);
    ok('已完成交接归还');
    await load();
  } catch (e: any) { err(e.message); }
}

async function disposeItem(l: LostItem) {
  try {
    await api.post(`/api/lost-items/${l.id}/dispose`);
    ok('已按无主物处理');
    await load();
  } catch (e: any) { err(e.message); }
}

onMounted(() => {
  load();
  tickTimer = window.setInterval(() => { now.value = Date.now(); }, 30000);
});
onUnmounted(() => clearInterval(tickTimer));
</script>

<template>
  <div class="container">
    <!-- 任务台 -->
    <div class="grid grid-3">
      <div class="card">
        <div class="card-title">🧴 待补液设备</div>
        <div v-if="tasks.lowDevices.length">
          <div v-for="d in tasks.lowDevices" :key="d.id" class="spread" style="padding:7px 0;border-bottom:1px solid var(--line)">
            <span><b>{{ d.code }}</b> <span class="muted">{{ d.site_name }}</span><br />
              <span :style="{ color: d.detergent_level < 20 ? 'var(--red)' : 'var(--amber)', fontWeight: 700 }">余量 {{ d.detergent_level }}%</span>
            </span>
            <button class="btn btn-primary btn-sm" @click="refillDevice(d)">补满</button>
          </div>
        </div>
        <div v-else class="empty">暂无待补液设备</div>
      </div>

      <div class="card">
        <div class="card-title">⏰ 超时未取 · 代取评估 <span class="sub">按倒计时 / 短信 / 排队判定</span></div>
        <div v-if="tasks.pickupOrders.length">
          <div v-for="o in tasks.pickupOrders" :key="o.id" style="padding:8px 0;border-bottom:1px solid var(--line)">
            <div class="spread">
              <span><b>{{ o.device_code }}</b> · {{ o.user_name }} <span class="muted">{{ o.site_name }}</span></span>
              <button v-if="o.eligibility.canProxy" class="btn btn-red btn-sm" @click="openCollect(o)">代取</button>
              <span v-else class="badge soft" :title="o.eligibility.reason">暂不可代取</span>
            </div>
            <div class="row mt8" style="gap:6px;flex-wrap:wrap">
              <span class="badge" :class="o.eligibility.overdue ? 'st-fault' : 'soft'">
                {{ o.eligibility.overdue ? `已超时 ${overdueText(o.pickup_deadline, now)}` : `倒计时 ${remainText(o.pickup_deadline, now) ?? '—'}` }}
              </span>
              <span class="badge" :class="o.eligibility.smsOk ? 'st-queued' : 'soft'">短信 ×{{ o.eligibility.smsCount }}</span>
              <span class="badge" :class="o.eligibility.queueOk ? 'st-queued' : 'soft'">
                排队 {{ o.eligibility.queueCount }} 人<template v-if="!o.eligibility.queueCount">（满 {{ o.eligibility.afterMin }} 分钟可代取）</template>
              </span>
            </div>
            <div v-if="!o.eligibility.canProxy" class="muted" style="font-size:12px;margin-top:4px">⛔ {{ o.eligibility.reason }}</div>
          </div>
        </div>
        <div v-else class="empty">暂无待取衣订单</div>
      </div>

      <div class="card">
        <div class="card-title">🤝 用户授权代取</div>
        <div v-if="tasks.auths.length">
          <div v-for="a in tasks.auths" :key="a.id" class="spread" style="padding:7px 0;border-bottom:1px solid var(--line)">
            <span><b>{{ a.device_code }}</b> · {{ a.user_name }}<br /><span class="muted">{{ a.order_no }}</span></span>
            <button class="btn btn-green btn-sm" @click="openCollect({ id: a.order_id, order_no: a.order_no, device_code: a.device_code, user_name: a.user_name }, a.id)">执行代取</button>
          </div>
        </div>
        <div v-else class="empty">暂无代取授权</div>
      </div>
    </div>

    <!-- 代取保管中 -->
    <div class="card mt16">
      <div class="card-title">🗄️ 代取保管中 <span class="sub">封袋入柜，等待用户核对取回；逾期自动转物业遗留物</span></div>
      <table class="table" v-if="tasks.proxyStored.length">
        <thead><tr><th>封袋编号</th><th>存放柜</th><th>物主</th><th>设备 / 门店</th><th>关联订单</th><th>入柜时间</th><th>保管截止</th></tr></thead>
        <tbody>
          <tr v-for="p in tasks.proxyStored" :key="p.id">
            <td style="font-weight:700">{{ p.bag_no }}</td>
            <td><span class="badge st-queued">{{ p.cabinet_no }}</span></td>
            <td>{{ p.user_name }}</td>
            <td>{{ p.device_code }} <span class="muted">{{ p.site_name }}</span></td>
            <td class="muted">{{ p.order_no }}</td>
            <td class="muted">{{ fmtTime(p.created_at) }}</td>
            <td>
              <span v-if="remainText(p.keep_until, now)" class="badge soft">剩余 {{ remainText(p.keep_until, now) }}</span>
              <span v-else class="badge st-fault">已逾期</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无保管中的代取衣物</div>
    </div>

    <!-- 巡检登记 -->
    <div class="card mt16">
      <div class="card-title">🧹 巡检登记 <span class="sub">地面 / 滤网 / 洗衣液 / 异味 / 遗留衣物 / 摄像头</span></div>
      <div class="form-row">
        <div class="field">
          <label>门店</label>
          <select class="select" v-model.number="form.site_id">
            <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </div>
        <div class="field">
          <label>地面</label>
          <select class="select" v-model="form.floor_status"><option v-for="o in OPTS" :key="o">{{ o }}</option></select>
        </div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>滤网</label>
          <select class="select" v-model="form.filter_status"><option v-for="o in ['正常', '积絮', '异常']" :key="o">{{ o }}</option></select>
        </div>
        <div class="field">
          <label>洗衣液</label>
          <select class="select" v-model="form.detergent_status"><option v-for="o in OPTS_DET" :key="o">{{ o }}</option></select>
        </div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>异味</label>
          <select class="select" v-model="form.odor_status"><option v-for="o in ['正常', '轻微异味', '明显异味']" :key="o">{{ o }}</option></select>
        </div>
        <div class="field">
          <label>遗留衣物</label>
          <select class="select" v-model="form.leftover_status"><option v-for="o in OPTS_LEFT" :key="o">{{ o }}</option></select>
        </div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>摄像头</label>
          <select class="select" v-model="form.camera_status"><option v-for="o in OPTS" :key="o">{{ o }}</option></select>
        </div>
        <div class="field">
          <label>备注</label>
          <input class="input" v-model="form.note" placeholder="如：A 区地面已拖洗，滤网已清理" />
        </div>
      </div>
      <button class="btn btn-primary" @click="submitInspection">提交巡检记录</button>
      <p class="muted mt8">提示：洗衣液不足 / 摄像头异常会自动生成对应工单</p>
    </div>

    <!-- 补货登记 -->
    <div class="card mt16">
      <div class="card-title">📦 洗涤用品补货</div>
      <div class="row">
        <select class="select" style="max-width:200px" v-model.number="restockForm.site_id">
          <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
        <select class="select" style="max-width:160px" v-model="restockForm.item">
          <option>洗衣液</option><option>消毒液</option><option>柔顺剂</option><option>洗衣袋</option>
        </select>
        <input class="input" style="max-width:110px" type="number" min="1" v-model.number="restockForm.quantity" placeholder="数量" />
        <input class="input" style="flex:1" v-model="restockForm.note" placeholder="备注（可选）" />
        <button class="btn btn-primary" @click="submitRestock">登记补货</button>
      </div>
    </div>

    <!-- 遗留物管理 -->
    <div class="card mt16">
      <div class="card-title">👕 遗留物保管</div>
      <table class="table" v-if="lostItems.length">
        <thead><tr><th>物品</th><th>门店/设备</th><th>保管点</th><th>状态</th><th>认领人</th><th>时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="l in lostItems" :key="l.id">
            <td>{{ l.description }}</td>
            <td>{{ l.site_name }} {{ l.device_code }}</td>
            <td>{{ l.keeper || '—' }}</td>
            <td><span class="badge soft">{{ LOST_STATUS[l.status] }}</span></td>
            <td>{{ l.claimed_by_name || '—' }}</td>
            <td class="muted">{{ fmtTime(l.created_at) }}</td>
            <td>
              <div class="row" style="gap:6px">
                <button v-if="['stored', 'claimed'].includes(l.status)" class="btn btn-green btn-sm" @click="returnItem(l)">交接归还</button>
                <button v-if="l.status === 'stored'" class="btn btn-ghost btn-sm" @click="disposeItem(l)">无主处理</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无遗留物</div>
    </div>

    <!-- 巡检历史 -->
    <div class="card mt16">
      <div class="card-title">巡检历史</div>
      <table class="table" v-if="inspections.length">
        <thead><tr><th>时间</th><th>门店</th><th>保洁</th><th>地面</th><th>滤网</th><th>洗衣液</th><th>异味</th><th>遗留</th><th>摄像头</th><th>备注</th></tr></thead>
        <tbody>
          <tr v-for="i in inspections" :key="i.id">
            <td class="muted">{{ fmtTime(i.created_at) }}</td>
            <td>{{ i.site_name }}</td>
            <td>{{ i.cleaner_name }}</td>
            <td>{{ i.floor_status }}</td>
            <td>{{ i.filter_status }}</td>
            <td :style="{ color: i.detergent_status === '不足' ? 'var(--red)' : 'inherit' }">{{ i.detergent_status }}</td>
            <td>{{ i.odor_status }}</td>
            <td>{{ i.leftover_status }}</td>
            <td :style="{ color: i.camera_status === '异常' ? 'var(--red)' : 'inherit' }">{{ i.camera_status }}</td>
            <td class="muted">{{ i.note || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无巡检记录</div>
    </div>

    <!-- 补货历史 -->
    <div class="card mt16">
      <div class="card-title">补货记录</div>
      <table class="table" v-if="restocks.length">
        <thead><tr><th>时间</th><th>门店</th><th>物品</th><th>数量</th><th>经办人</th><th>备注</th></tr></thead>
        <tbody>
          <tr v-for="r in restocks" :key="r.id">
            <td class="muted">{{ fmtTime(r.created_at) }}</td>
            <td>{{ r.site_name }}</td>
            <td>{{ r.item }}</td>
            <td>{{ r.quantity }}</td>
            <td>{{ r.operator_name || '—' }}</td>
            <td class="muted">{{ r.note || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无补货记录</div>
    </div>

    <!-- 代取弹窗：拍照 / 封袋 / 存放柜 / 保洁确认 -->
    <Modal v-if="collectOrder" :title="`保洁代取 · 订单 ${collectOrder.order_no}`" @close="collectOrder = null">
      <div class="alert warn">
        {{ collectAuthId ? '用户已授权代取' : '超时未取强制代取' }}：请完成「拍照留档 → 封袋编号 → 存放柜 → 现场确认」四步，提交后设备立即释放，并生成用户确认任务。
      </div>
      <div class="field mt12">
        <label>① 拍照留档（现场照片记录）</label>
        <div class="row">
          <input class="input" style="flex:1" v-model="collectForm.photo_note" placeholder="照片说明，如：桶内衣物一袋，外套 1 件、T 恤 2 件" />
          <button class="btn btn-outline btn-sm" @click="mockPhoto">📷 模拟拍照</button>
        </div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>② 封袋编号（写在实体封袋上）</label>
          <input class="input" v-model="collectForm.bag_no" placeholder="如 BAG20260917001" />
        </div>
        <div class="field">
          <label>③ 存放柜编号</label>
          <select class="select" v-model="collectForm.cabinet_no">
            <option v-for="c in CABINETS" :key="c" :value="c">{{ c }} 柜</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label class="row" style="gap:8px;align-items:flex-start">
          <input type="checkbox" v-model="collectForm.confirmed" style="margin-top:3px" />
          <span>④ 保洁确认：已现场核对衣物、完成拍照留档，衣物已封袋并放入对应存放柜。代取后将生成用户确认任务，用户取回时需核对封袋编号并扫码确认。</span>
        </label>
      </div>
      <button class="btn btn-red btn-block" :disabled="!collectForm.confirmed" @click="submitCollect">确认代取并入柜</button>
    </Modal>
  </div>
</template>
