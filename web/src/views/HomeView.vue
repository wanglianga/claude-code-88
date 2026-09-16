<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import type { Board, Device, Order, Quote, Site, WashMode } from '../types';
import { DEVICE_STATUS, ORDER_STATUS, fen, fmtTime, remainText, overdueText, SITE_KIND } from '../utils';
import { ok, err } from '../toast';
import DeviceCard from '../components/DeviceCard.vue';
import Modal from '../components/Modal.vue';

const sites = ref<Site[]>([]);
const siteId = ref<number>(0);
const board = ref<Board | null>(null);
const active = ref<Order | null>(null);
const now = ref(Date.now());
const loading = ref(false);

// 预约弹窗
const bookDevice = ref<Device | null>(null);
const bookModeId = ref<number>(0);
const quote = ref<Quote | null>(null);
const payMethod = ref('wechat');
const booking = ref(false);

// 上报弹窗
const reportOpen = ref(false);
const reportType = ref('mid_stop');
const reportDesc = ref('');
const REPORT_OPTIONS = [
  { v: 'mid_stop', t: '设备中途停机' },
  { v: 'dryer_not_dry', t: '烘干不干' },
  { v: 'detergent_low', t: '洗衣液不足' },
  { v: 'wrong_pickup', t: '衣物错拿申诉' },
  { v: 'door_stuck', t: '门锁打不开' },
  { v: 'refund_request', t: '退款申请' },
  { v: 'other', t: '其他问题' },
];

// 扫码
const scanCode = ref('');

let tickTimer: number | undefined;
let pollTimer: number | undefined;

const site = computed(() => sites.value.find((s) => s.id === siteId.value));
const zones = computed(() => {
  if (!board.value) return [];
  const map = new Map<string, Device[]>();
  for (const d of board.value.devices) {
    const z = d.zone_name || '未分区';
    if (!map.has(z)) map.set(z, []);
    map.get(z)!.push(d);
  }
  return [...map.entries()].map(([name, devices]) => ({ name, devices }));
});

const activeStatus = computed(() => (active.value ? ORDER_STATUS[active.value.status] : null));
const washRemain = computed(() => (active.value?.status === 'running' ? remainText(active.value.ends_at, now.value) : null));
const pickupRemain = computed(() => (active.value?.status === 'finished' ? remainText(active.value.pickup_deadline, now.value) : null));
const pickupOverdue = computed(() => (active.value?.status === 'finished' ? overdueText(active.value.pickup_deadline, now.value) : null));
const progress = computed(() => {
  const o = active.value;
  if (!o || o.status !== 'running' || !o.started_at || !o.ends_at) return 0;
  const total = new Date(o.ends_at).getTime() - new Date(o.started_at).getTime();
  const left = new Date(o.ends_at).getTime() - now.value;
  return Math.min(100, Math.max(0, Math.round(((total - left) / total) * 100)));
});

async function loadSites() {
  sites.value = await api.get<Site[]>('/api/sites');
  if (sites.value.length && !siteId.value) siteId.value = sites.value[0].id;
}

async function loadBoard() {
  if (!siteId.value) return;
  board.value = await api.get<Board>(`/api/sites/${siteId.value}/board`);
}

async function loadActive() {
  active.value = await api.get<Order | null>('/api/orders/active');
}

async function refresh() {
  await Promise.all([loadBoard(), loadActive()]);
}

async function switchSite(id: number) {
  siteId.value = id;
  await loadBoard();
}

function openBook(d: Device) {
  bookDevice.value = d;
  bookModeId.value = d.modes[0]?.id || 0;
  quote.value = null;
  if (bookModeId.value) loadQuote();
}

async function loadQuote() {
  if (!bookDevice.value || !bookModeId.value) return;
  quote.value = await api.get<Quote>(`/api/quote?device_id=${bookDevice.value.id}&mode_id=${bookModeId.value}`);
}

async function submitBook() {
  if (!bookDevice.value || !bookModeId.value) return;
  booking.value = true;
  try {
    await api.post('/api/orders', { device_id: bookDevice.value.id, mode_id: bookModeId.value });
    ok('预约成功，请在 10 分钟内完成支付');
    bookDevice.value = null;
    await refresh();
  } catch (e: any) {
    err(e.message);
  } finally {
    booking.value = false;
  }
}

async function pay() {
  if (!active.value) return;
  try {
    const r = await api.post<{ message: string }>(`/api/orders/${active.value.id}/pay`, { method: payMethod.value });
    ok(r.message);
    await refresh();
  } catch (e: any) { err(e.message); }
}

async function start() {
  if (!active.value) return;
  try {
    const r = await api.post<{ ends_in_min: number }>(`/api/orders/${active.value.id}/start`);
    ok(`设备已启动，约 ${r.ends_in_min} 分钟后完成`);
    await refresh();
  } catch (e: any) { err(e.message); }
}

async function pickup() {
  if (!active.value) return;
  try {
    await api.post(`/api/orders/${active.value.id}/pickup`);
    ok('取衣完成，感谢使用');
    await refresh();
  } catch (e: any) { err(e.message); }
}

async function cancelOrder() {
  if (!active.value) return;
  try {
    const r = await api.post<{ message: string }>(`/api/orders/${active.value.id}/cancel`);
    ok(r.message);
    await refresh();
  } catch (e: any) { err(e.message); }
}

async function simulateFinish() {
  if (!active.value) return;
  try {
    const r = await api.post<{ message: string }>(`/api/devices/${active.value.device_id}/callback`, { event: 'cycle_finished' });
    ok(r.message);
    await refresh();
  } catch (e: any) { err(e.message); }
}

async function authorizePickup() {
  if (!active.value) return;
  try {
    const r = await api.post<{ message: string }>(`/api/orders/${active.value.id}/authorize-pickup`);
    ok(r.message);
    await refresh();
  } catch (e: any) { err(e.message); }
}

async function submitReport() {
  if (!active.value) return;
  try {
    await api.post(`/api/orders/${active.value.id}/report`, { type: reportType.value, description: reportDesc.value });
    ok('已提交，相关工作人员将尽快处理');
    reportOpen.value = false;
    reportDesc.value = '';
  } catch (e: any) { err(e.message); }
}

async function doScan() {
  if (!scanCode.value.trim()) return;
  try {
    const d = await api.get<{ id: number; site_id: number; code: string }>(`/api/devices/scan/${scanCode.value.trim()}`);
    ok(`已定位设备 ${d.code}`);
    if (d.site_id !== siteId.value) {
      siteId.value = d.site_id;
      await loadBoard();
    }
    const dev = board.value?.devices.find((x) => x.id === d.id);
    if (dev) openBook(dev);
    scanCode.value = '';
  } catch (e: any) { err(e.message); }
}

onMounted(async () => {
  loading.value = true;
  try {
    await loadSites();
    await refresh();
  } finally {
    loading.value = false;
  }
  tickTimer = window.setInterval(() => { now.value = Date.now(); }, 1000);
  pollTimer = window.setInterval(refresh, 10000);
});
onUnmounted(() => { clearInterval(tickTimer); clearInterval(pollTimer); });
</script>

<template>
  <div class="container">
    <!-- 门店切换 -->
    <div class="tabs">
      <div v-for="s in sites" :key="s.id" class="tab" :class="{ active: s.id === siteId }" @click="switchSite(s.id)">
        {{ s.name }}
        <span class="badge soft" style="margin-left:4px">{{ SITE_KIND[s.kind] }}</span>
      </div>
    </div>

    <!-- 门店运营规则 -->
    <div v-if="site" class="card">
      <div class="spread">
        <div class="row">
          <span class="badge soft">📍 {{ site.address }}</span>
          <span v-if="site.rules.nightSilent?.enabled" class="badge night">
            🌙 夜间静音 {{ site.rules.nightSilent.start }}~{{ site.rules.nightSilent.end }}
          </span>
          <span v-if="board?.night_now" class="badge st-fault">当前为静音时段</span>
          <span v-for="p in site.rules.offPeak || []" :key="p.start" class="badge st-idle">⚡ {{ p.label }} {{ p.start }}~{{ p.end }}</span>
          <span v-for="p in site.rules.peakPricing || []" :key="p.start" class="badge st-queued">📈 {{ p.label }} {{ p.start }}~{{ p.end }}</span>
          <span class="badge soft">取衣宽限 {{ site.rules.pickupGraceMin }} 分钟</span>
          <span class="badge soft">每日限约 {{ site.rules.maxDailyOrdersPerUser }} 单</span>
          <span class="badge soft">信用门槛 {{ site.rules.minCreditToBook }} 分</span>
        </div>
      </div>
      <p class="muted mt8">{{ site.rules.note }}</p>
      <div class="row mt12">
        <input class="input" style="max-width:260px" v-model="scanCode" placeholder="模拟扫码：输入设备编号，如 QS-W101" @keyup.enter="doScan" />
        <button class="btn btn-outline" @click="doScan">📷 扫码开机</button>
      </div>
    </div>

    <!-- 进行中订单 -->
    <div v-if="active" class="card mt16" style="border-left:4px solid var(--primary)">
      <div class="spread">
        <div class="card-title" style="margin:0">
          我的当前订单
          <span class="badge" :class="activeStatus?.cls">{{ activeStatus?.label }}</span>
          <span v-if="active.overdue" class="badge st-fault">已超时</span>
        </div>
        <span class="muted">{{ active.order_no }}</span>
      </div>

      <div class="grid grid-4 mt12">
        <div><div class="muted">设备</div><b>{{ active.device_code }}</b>（{{ active.site_name }}）</div>
        <div><div class="muted">洗涤程序</div><b>{{ active.mode_name }}</b></div>
        <div><div class="muted">金额</div><b>{{ fen(active.amount_cents) }}</b>
          <span v-if="active.discount_cents > 0" class="muted">（已优惠 {{ fen(active.discount_cents) }}）</span>
        </div>
        <div><div class="muted">支付</div>{{ active.pay_status === 'paid' ? '已支付' : '待支付' }}</div>
      </div>

      <!-- 待支付 -->
      <div v-if="active.status === 'booked'" class="mt12">
        <div class="alert warn">⏳ 请在 10 分钟内完成支付，超时预约自动取消</div>
        <div class="row mt12">
          <select class="select" style="max-width:160px" v-model="payMethod">
            <option value="wechat">微信支付</option>
            <option value="alipay">支付宝</option>
            <option value="balance">余额支付</option>
          </select>
          <button class="btn btn-primary" @click="pay">立即支付 {{ fen(active.amount_cents) }}</button>
          <button class="btn btn-ghost" @click="cancelOrder">取消预约</button>
        </div>
      </div>

      <!-- 排队中 -->
      <div v-else-if="active.status === 'paid'" class="mt12">
        <div class="alert info">
          🎫 已支付，排队位置：第 <b>{{ active.queue_position ?? 1 }}</b> / {{ active.queue_count }} 位。
          轮到且设备空闲后即可启动。
        </div>
        <div class="row mt12">
          <button class="btn btn-green" @click="start">▶ 启动设备</button>
          <button class="btn btn-ghost" @click="cancelOrder">取消并退款</button>
        </div>
      </div>

      <!-- 洗涤中 -->
      <div v-else-if="active.status === 'running'" class="mt12">
        <div class="progress-ring">
          <div>
            <div class="muted">距离结束（结束前 5 分钟将推送提醒）</div>
            <div class="countdown-big">{{ washRemain ?? '即将完成' }}</div>
          </div>
          <div style="flex:1">
            <div class="meter"><i :style="{ width: progress + '%' }"></i></div>
            <div class="muted mt8">预计 {{ fmtTime(active.ends_at) }} 完成 · 完成后请在宽限时间内取衣</div>
          </div>
        </div>
        <div class="row mt12">
          <button class="btn btn-outline btn-sm" @click="simulateFinish">🔧 模拟设备完成回调</button>
          <button class="btn btn-ghost btn-sm" @click="reportOpen = true">⚠️ 上报问题</button>
        </div>
      </div>

      <!-- 待取衣 -->
      <div v-else-if="active.status === 'finished'" class="mt12">
        <div v-if="pickupRemain" class="alert info">👕 洗涤完成！取衣倒计时 <b>{{ pickupRemain }}</b>，超时将扣减信用并由保洁代收</div>
        <div v-else class="alert error">⚠️ 已超时 {{ pickupOverdue }}！信用已扣减，请立即取衣，逾期将由保洁代收存入遗留物柜</div>
        <div class="row mt12">
          <button class="btn btn-green" @click="pickup">✅ 我已取衣</button>
          <button class="btn btn-outline" :disabled="!!active.pickup_auth" @click="authorizePickup">
            {{ active.pickup_auth ? '已授权保洁代取' : '🤝 授权保洁代取' }}
          </button>
          <button class="btn btn-ghost" @click="reportOpen = true">⚠️ 上报问题</button>
        </div>
      </div>
    </div>

    <!-- 设备分区看板 -->
    <div v-for="z in zones" :key="z.name">
      <div class="section-title">{{ z.name }}<span class="muted">{{ z.devices.length }} 台设备</span></div>
      <div class="grid grid-3">
        <DeviceCard v-for="d in z.devices" :key="d.id" :device="d" :now="now" :night-now="board?.night_now ?? false" @book="openBook" />
      </div>
    </div>
    <div v-if="!loading && !zones.length" class="empty">暂无设备数据</div>

    <!-- 预约弹窗 -->
    <Modal v-if="bookDevice" :title="`预约设备 ${bookDevice.code}`" @close="bookDevice = null">
      <div class="device-meta" style="margin-bottom:12px">
        <span class="badge soft">{{ bookDevice.type === 'washer' ? '洗衣机' : '烘干机' }} · {{ bookDevice.capacity_kg }}kg</span>
        <span class="badge" :class="DEVICE_STATUS[bookDevice.status].cls">{{ DEVICE_STATUS[bookDevice.status].label }}</span>
        <span v-if="bookDevice.queue_count" class="badge st-queued">前方 {{ bookDevice.queue_count }} 人排队</span>
        <span v-if="bookDevice.silent" class="badge night">🔇 静音机型</span>
      </div>
      <div class="field">
        <label>选择洗涤模式</label>
        <div class="mode-list">
          <div v-for="m in bookDevice.modes" :key="m.id" class="mode-item" :class="{ selected: m.id === bookModeId }"
               @click="bookModeId = m.id; loadQuote()">
            <span>{{ m.name }}<div class="muted">{{ m.description }}</div></span>
            <span class="price">{{ fen(m.price_cents) }}</span>
          </div>
        </div>
      </div>
      <div v-if="quote" class="card" style="background:var(--bg);box-shadow:none;padding:12px">
        <div class="meta-line"><span>模式价格</span><span>{{ fen(quote.base) }}</span></div>
        <div v-if="quote.multiplier !== 1" class="meta-line">
          <span>{{ quote.multiplierLabel }}</span><span>×{{ quote.multiplier }}</span>
        </div>
        <div v-if="quote.memberLabel" class="meta-line">
          <span>{{ quote.memberLabel }}</span><span>-{{ fen(quote.discount) }}</span>
        </div>
        <div v-if="quote.free_wash_available" class="meta-line">
          <span>免费洗涤次数</span><span style="color:var(--green)">可用（支付时自动抵扣）</span>
        </div>
        <div class="meta-line" style="font-size:15px;font-weight:800;color:var(--ink)">
          <span>应付</span><span style="color:var(--primary)">{{ fen(quote.amount) }}</span>
        </div>
      </div>
      <button class="btn btn-primary btn-block mt12" :disabled="booking" @click="submitBook">
        {{ booking ? '提交中...' : '确认预约' }}
      </button>
      <p class="muted mt8" style="text-align:center">预约后 10 分钟内支付有效 · 支付后进入设备队列</p>
    </Modal>

    <!-- 问题上报弹窗 -->
    <Modal v-if="reportOpen" title="上报问题" @close="reportOpen = false">
      <div class="field">
        <label>问题类型</label>
        <select class="select" v-model="reportType">
          <option v-for="o in REPORT_OPTIONS" :key="o.v" :value="o.v">{{ o.t }}</option>
        </select>
      </div>
      <div class="field">
        <label>问题描述</label>
        <textarea class="textarea" v-model="reportDesc" placeholder="请描述具体情况，如：烘干 60 分钟后衣物仍然潮湿…"></textarea>
      </div>
      <div class="alert info">提交后将生成工单，客服 / 保洁 / 维修 / 物业会围绕本订单协同处理，处理进度可在「我的工单」查看。</div>
      <button class="btn btn-primary btn-block mt12" @click="submitReport">提交</button>
    </Modal>
  </div>
</template>
