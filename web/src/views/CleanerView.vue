<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import type { Cabinet, Inspection, LostItem, OverdueOrder, ProxyPickup, Site } from '../types';
import { fen, fmtTime, remainText, overdueText, LOST_STATUS, PROXY_STATUS } from '../utils';
import { ok, err } from '../toast';
import Modal from '../components/Modal.vue';

interface Tasks {
  lowDevices: { id: number; code: string; detergent_level: number; site_name: string }[];
  overdueOrders: OverdueOrder[];
  auths: { id: number; order_id: number; order_no: string; user_name: string; device_code: string; site_name: string }[];
}

const auth = useAuthStore();
const sites = ref<Site[]>([]);
const tasks = ref<Tasks>({ lowDevices: [], overdueOrders: [], auths: [] });
const inspections = ref<Inspection[]>([]);
const restocks = ref<any[]>([]);
const lostItems = ref<LostItem[]>([]);
const proxyPickups = ref<ProxyPickup[]>([]);
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

// 代取弹窗
const pickupOrder = ref<OverdueOrder | null>(null);
const pickupPhoto = ref('');
const pickupCabinets = ref<Cabinet[]>([]);
const pickupCabinet = ref('');
const pickupConfirm = ref(false);
const pickupNote = ref('');
const pickupStorageHours = ref(72);
const submitting = ref(false);

const canSubmitPickup = computed(
  () => !!pickupPhoto.value && !!pickupCabinet.value && pickupConfirm.value && !submitting.value
);

async function load() {
  const [s, t, i, r, l, p] = await Promise.all([
    api.get<Site[]>('/api/sites'),
    api.get<Tasks>('/api/cleaner/tasks'),
    api.get<Inspection[]>('/api/inspections'),
    api.get<any[]>('/api/restocks'),
    api.get<LostItem[]>('/api/lost-items'),
    api.get<ProxyPickup[]>('/api/proxy-pickups'),
  ]);
  sites.value = s;
  tasks.value = t;
  inspections.value = i;
  restocks.value = r;
  lostItems.value = l;
  proxyPickups.value = p;
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

/* ---------- 代取 ---------- */
async function openProxyPickup(o: OverdueOrder) {
  pickupOrder.value = o;
  pickupPhoto.value = '';
  pickupCabinet.value = '';
  pickupConfirm.value = false;
  pickupNote.value = '';
  try {
    const r = await api.get<{ storage_hours: number; cabinets: Cabinet[] }>(`/api/sites/${o.site_id}/cabinets`);
    pickupCabinets.value = r.cabinets;
    pickupStorageHours.value = r.storage_hours;
    const firstFree = r.cabinets.find((c) => !c.occupied);
    pickupCabinet.value = firstFree?.no || '';
  } catch (e: any) { err(e.message); }
}

/** 拍照上传：压缩为 ≤320px JPEG dataURL */
function onPhotoChange(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 320 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      pickupPhoto.value = canvas.toDataURL('image/jpeg', 0.7);
    };
    img.src = String(reader.result);
  };
  reader.readAsDataURL(file);
}

/** 模拟拍照：生成带设备编号与时间的占位照片 */
function simulatePhoto() {
  if (!pickupOrder.value) return;
  const o = pickupOrder.value;
  const ts = new Date().toLocaleString('zh-CN');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">
    <rect width="320" height="200" fill="#3b4252"/>
    <rect x="16" y="16" width="288" height="168" rx="8" fill="#eceff4"/>
    <text x="160" y="80" font-size="22" text-anchor="middle" fill="#2e3440">📷 衣物出机留证</text>
    <text x="160" y="115" font-size="16" text-anchor="middle" fill="#4c566a">设备 ${o.device_code} · ${o.order_no}</text>
    <text x="160" y="142" font-size="13" text-anchor="middle" fill="#4c566a">${ts}</text>
  </svg>`;
  pickupPhoto.value = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
}

async function submitProxyPickup() {
  if (!pickupOrder.value || !canSubmitPickup.value) return;
  submitting.value = true;
  try {
    const r = await api.post<{ bag_no: string; cabinet_no: string; pickup_code: string }>(
      `/api/orders/${pickupOrder.value.id}/proxy-pickup`,
      { photo: pickupPhoto.value, cabinet_no: pickupCabinet.value, confirm: pickupConfirm.value, note: pickupNote.value }
    );
    ok(`代取完成：封袋 ${r.bag_no} 已存 ${r.cabinet_no} 柜，取件码 ${r.pickup_code}，设备已释放`);
    pickupOrder.value = null;
    await load();
  } catch (e: any) { err(e.message); }
  finally { submitting.value = false; }
}

async function disposePickup(p: ProxyPickup) {
  const note = prompt(`处置逾期衣物（封袋 ${p.bag_no}）备注`, '超过保管期限，按无主遗留物处理') || '';
  try {
    await api.post(`/api/proxy-pickups/${p.id}/dispose`, { note });
    ok('已按遗留物规定处置');
    await load();
  } catch (e: any) { err(e.message); }
}

async function useAuth(a: { id: number }) {
  try {
    await api.post(`/api/pickup-auths/${a.id}/use`);
    ok('代取完成，衣物已存入保管柜');
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

const storeRemain = (p: ProxyPickup) => remainText(p.store_until, now.value) || '已到期';

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
        <div class="card-title">⏰ 超时未取 · 占机代取 <span class="sub">按倒计时 / 短信提醒 / 排队人数判定</span></div>
        <div v-if="tasks.overdueOrders.length">
          <div v-for="o in tasks.overdueOrders" :key="o.id" style="padding:9px 0;border-bottom:1px solid var(--line)">
            <div class="spread">
              <span><b>{{ o.device_code }}</b> · {{ o.user_name }}<br />
                <span class="muted">{{ o.order_no }} · 宽限于 {{ fmtTime(o.pickup_deadline) }}</span>
              </span>
              <button class="btn btn-sm" :class="o.eligible ? 'btn-red' : 'btn-ghost'" :disabled="!o.eligible"
                      @click="openProxyPickup(o)">
                {{ o.eligible ? '代取封存' : '暂不可代取' }}
              </button>
            </div>
            <div class="check-list">
              <span v-for="c in o.checks" :key="c.key" class="check-item" :class="{ ok: c.ok }" :title="c.detail">
                {{ c.ok ? '✓' : '✗' }} {{ c.label }}
              </span>
            </div>
          </div>
        </div>
        <div v-else class="empty">暂无超时订单</div>
      </div>

      <div class="card">
        <div class="card-title">🤝 用户授权代取</div>
        <div v-if="tasks.auths.length">
          <div v-for="a in tasks.auths" :key="a.id" class="spread" style="padding:7px 0;border-bottom:1px solid var(--line)">
            <span><b>{{ a.device_code }}</b> · {{ a.user_name }}<br /><span class="muted">{{ a.order_no }}</span></span>
            <button class="btn btn-green btn-sm" @click="useAuth(a)">执行代取</button>
          </div>
        </div>
        <div v-else class="empty">暂无代取授权</div>
      </div>
    </div>

    <!-- 代取保管 -->
    <div class="card mt16">
      <div class="card-title">🛅 代取衣物保管 <span class="sub">封袋编号 / 柜号 / 保管期限，逾期移交物业</span></div>
      <table class="table" v-if="proxyPickups.length">
        <thead><tr><th>封袋编号</th><th>用户 / 订单</th><th>柜号</th><th>照片</th><th>保管截止</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="p in proxyPickups" :key="p.id">
            <td style="font-weight:700">{{ p.bag_no }}<br /><span class="muted" style="font-weight:400">{{ p.pickup_no }}</span></td>
            <td>{{ p.user_name }}<br /><span class="muted">{{ p.order_no }} · {{ p.device_code }}</span></td>
            <td><span class="badge soft">{{ p.cabinet_no }}</span></td>
            <td>
              <img v-if="p.photo_url" :src="p.photo_url" style="width:44px;height:32px;object-fit:cover;border-radius:6px;border:1px solid var(--line)" />
              <span v-else class="muted">—</span>
            </td>
            <td>
              <template v-if="p.status === 'stored'">
                <span :style="{ color: storeRemain(p) === '已到期' ? 'var(--red)' : 'inherit', fontWeight: 700 }">{{ storeRemain(p) }}</span>
                <br /><span class="muted">{{ fmtTime(p.store_until) }}</span>
              </template>
              <span v-else class="muted">{{ fmtTime(p.store_until) }}</span>
            </td>
            <td><span class="badge" :class="PROXY_STATUS[p.status]?.cls">{{ PROXY_STATUS[p.status]?.label }}</span></td>
            <td>
              <button v-if="p.status === 'escalated' && auth.user?.role === 'property'"
                      class="btn btn-red btn-sm" @click="disposePickup(p)">物业处置</button>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无代取记录</div>
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

    <!-- 代取弹窗：拍照 + 封袋 + 柜号 + 保洁确认 -->
    <Modal v-if="pickupOrder" :title="`代取封存 · ${pickupOrder.device_code} · ${pickupOrder.order_no}`" @close="pickupOrder = null">
      <div class="alert warn">
        用户 {{ pickupOrder.user_name }} 超时未取，请完成以下四步：拍照留证 → 系统生成封袋编号 → 选择存放柜 → 本人确认。
        保管期限 {{ pickupStorageHours }} 小时，逾期将移交物业。
      </div>

      <div class="field">
        <label>① 拍照留证（衣物出机照片）</label>
        <div class="row">
          <input class="input" type="file" accept="image/*" @change="onPhotoChange" />
          <button class="btn btn-outline btn-sm" @click="simulatePhoto">📷 模拟拍照</button>
        </div>
        <div v-if="pickupPhoto" class="mt8">
          <img :src="pickupPhoto" style="max-width:100%;max-height:150px;border-radius:8px;border:1px solid var(--line)" />
        </div>
        <div v-else class="muted mt8">未拍照不可提交</div>
      </div>

      <div class="form-row">
        <div class="field">
          <label>② 封袋编号（提交时系统生成并打印）</label>
          <input class="input" value="提交后自动生成，如 BAG20260917…" disabled />
        </div>
        <div class="field">
          <label>③ 存放柜编号</label>
          <select class="select" v-model="pickupCabinet">
            <option value="" disabled>请选择柜号</option>
            <option v-for="c in pickupCabinets" :key="c.no" :value="c.no" :disabled="c.occupied">
              {{ c.no }} {{ c.occupied ? `（占用中 ${c.bag_no}）` : '（空闲）' }}
            </option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>衣物备注（可选）</label>
        <input class="input" v-model="pickupNote" placeholder="如：外套两件、牛仔裤一条" />
      </div>

      <div class="field">
        <label class="row" style="gap:8px;align-items:flex-start;cursor:pointer">
          <input type="checkbox" v-model="pickupConfirm" style="margin-top:3px" />
          <span>④ 保洁确认：本人已现场核对衣物、拍照留证并封袋贴标，衣物与订单 {{ pickupOrder.order_no }} 一致</span>
        </label>
      </div>

      <button class="btn btn-red btn-block" :disabled="!canSubmitPickup" @click="submitProxyPickup">
        {{ submitting ? '提交中…' : '确认代取封存（释放设备）' }}
      </button>
    </Modal>
  </div>
</template>
