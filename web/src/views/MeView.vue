<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import type { CreditRecord, LostItem, Notification, Package, ProxyPickup, Refund } from '../types';
import { fen, fmtTime, remainText, LOST_STATUS, PROXY_STATUS, REFUND_STATUS } from '../utils';
import { ok, err } from '../toast';
import Modal from '../components/Modal.vue';

const auth = useAuthStore();
const packages = ref<Package[]>([]);
const credits = ref<CreditRecord[]>([]);
const lostItems = ref<LostItem[]>([]);
const refunds = ref<Refund[]>([]);
const proxyPickups = ref<ProxyPickup[]>([]);
const tab = ref<'notif' | 'proxy' | 'credit' | 'lost' | 'refund'>('notif');
const now = ref(Date.now());
let tickTimer: number | undefined;

// 取回确认弹窗
const confirmTask = ref<ProxyPickup | null>(null);
const inputBagNo = ref('');
const inputCode = ref('');
const confirming = ref(false);

const pendingTasks = computed(() => proxyPickups.value.filter((p) => p.status === 'stored'));
const storeRemain = (p: ProxyPickup) => remainText(p.store_until, now.value);

async function load() {
  const [p, c, l, r, px] = await Promise.all([
    api.get<Package[]>('/api/packages'),
    api.get<CreditRecord[]>('/api/me/credit-records'),
    api.get<LostItem[]>('/api/lost-items'),
    api.get<Refund[]>('/api/refunds'),
    api.get<ProxyPickup[]>('/api/proxy-pickups/mine'),
  ]);
  packages.value = p;
  credits.value = c;
  lostItems.value = l;
  refunds.value = r;
  proxyPickups.value = px;
  await auth.loadNotifications();
}

async function buy(p: Package) {
  try {
    const r = await api.post<{ message: string }>(`/api/packages/${p.id}/buy`);
    ok(r.message);
    await auth.refreshMe();
  } catch (e: any) { err(e.message); }
}

async function claim(item: LostItem) {
  try {
    const r = await api.post<{ message: string }>(`/api/lost-items/${item.id}/claim`);
    ok(r.message);
    await load();
  } catch (e: any) { err(e.message); }
}

function openConfirm(p: ProxyPickup) {
  confirmTask.value = p;
  inputBagNo.value = '';
  inputCode.value = '';
}

async function submitConfirm() {
  if (!confirmTask.value || confirming.value) return;
  confirming.value = true;
  try {
    const r = await api.post<{ message: string }>(`/api/proxy-pickups/${confirmTask.value.id}/confirm-return`, {
      bag_no: inputBagNo.value.trim(),
      pickup_code: inputCode.value.trim(),
    });
    ok(r.message);
    confirmTask.value = null;
    await load();
  } catch (e: any) { err(e.message); }
  finally { confirming.value = false; }
}

async function readAll() {
  await auth.readAll();
}

onMounted(() => {
  load();
  tickTimer = window.setInterval(() => { now.value = Date.now(); }, 30000);
});
onUnmounted(() => clearInterval(tickTimer));
</script>

<template>
  <div class="container">
    <!-- 待取回代取任务强提醒 -->
    <div v-if="pendingTasks.length" class="alert warn" style="margin-bottom:16px;cursor:pointer" @click="tab = 'proxy'">
      🛅 你有 <b>{{ pendingTasks.length }}</b> 件衣物被保洁代取封存，请在保管期限内核对取回（封袋 {{ pendingTasks.map(p => p.bag_no).join('、') }}）→ 点击前往「代取任务」
    </div>

    <div class="grid grid-2">
      <!-- 我的信息 -->
      <div class="card">
        <div class="card-title">我的信息</div>
        <div class="row" style="gap:14px">
          <div style="font-size:38px">👤</div>
          <div>
            <div style="font-weight:800;font-size:16px">{{ auth.user?.name }}</div>
            <div class="muted">{{ auth.user?.username }} · {{ auth.user?.phone }}</div>
            <div class="row mt8">
              <span class="credit-chip" :class="{ low: (auth.user?.credit ?? 100) < 60 }">信用分 {{ auth.user?.credit }}</span>
              <span v-if="auth.user?.package" class="badge st-finished">
                {{ auth.user.package.name }} · 有效期至 {{ fmtTime(auth.user.package_expires_at) }}
              </span>
              <span v-if="(auth.user?.free_washes ?? 0) > 0" class="badge st-idle">免费洗涤 ×{{ auth.user?.free_washes }}</span>
            </div>
          </div>
        </div>
        <div v-if="(auth.user?.credit ?? 100) < 60" class="alert error mt12">
          信用分低于 60，部分门店将限制预约。请按时取衣、文明使用以恢复信用。
        </div>
      </div>

      <!-- 会员套餐 -->
      <div class="card">
        <div class="card-title">会员套餐 <span class="sub">开通后自动享受折扣</span></div>
        <div class="grid" style="gap:10px">
          <div v-for="p in packages" :key="p.id" class="mode-item">
            <span>
              <b>{{ p.name }}</b> <span class="badge soft">{{ p.discount_pct / 10 }} 折</span>
              <span v-if="p.free_washes" class="badge st-idle">赠 {{ p.free_washes }} 次</span>
              <div class="muted">{{ p.description }}</div>
            </span>
            <span class="row">
              <b style="color:var(--primary)">{{ fen(p.price_cents) }}</b>
              <button class="btn btn-primary btn-sm" @click="buy(p)">开通</button>
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- 标签页 -->
    <div class="tabs mt16">
      <div class="tab" :class="{ active: tab === 'notif' }" @click="tab = 'notif'">通知 <span v-if="auth.unread" class="badge st-fault">{{ auth.unread }}</span></div>
      <div class="tab" :class="{ active: tab === 'proxy' }" @click="tab = 'proxy'">代取任务 <span v-if="pendingTasks.length" class="badge st-finished">{{ pendingTasks.length }}</span></div>
      <div class="tab" :class="{ active: tab === 'credit' }" @click="tab = 'credit'">信用档案</div>
      <div class="tab" :class="{ active: tab === 'lost' }" @click="tab = 'lost'">遗留物</div>
      <div class="tab" :class="{ active: tab === 'refund' }" @click="tab = 'refund'">退款记录</div>
    </div>

    <div v-if="tab === 'notif'" class="card">
      <div class="spread">
        <div class="card-title" style="margin:0">消息通知</div>
        <button class="btn btn-ghost btn-sm" @click="readAll">全部已读</button>
      </div>
      <div v-if="auth.notifications.length" class="mt12">
        <div v-for="n in auth.notifications" :key="n.id" class="notif-item" :class="{ unread: !n.read }">
          <div class="t">{{ n.read ? '' : '🔴 ' }}{{ n.title }}</div>
          <div class="b">{{ n.body }}</div>
          <div class="muted">{{ fmtTime(n.created_at) }}</div>
        </div>
      </div>
      <div v-else class="empty">暂无通知</div>
    </div>

    <div v-if="tab === 'proxy'" class="card">
      <div class="card-title">代取任务 <span class="sub">保洁代取的衣物需核对封袋编号并扫码取回，逾期移交物业</span></div>
      <div v-if="proxyPickups.length" class="grid grid-2">
        <div v-for="p in proxyPickups" :key="p.id" class="proxy-card" :class="{ pending: p.status === 'stored' }">
          <div class="spread">
            <b>封袋 {{ p.bag_no }}</b>
            <span class="badge" :class="PROXY_STATUS[p.status]?.cls">{{ PROXY_STATUS[p.status]?.label }}</span>
          </div>
          <div class="proxy-line"><span>存放柜</span><b>{{ p.cabinet_no }} 柜 · {{ p.site_name }}</b></div>
          <div class="proxy-line"><span>关联订单</span><span>{{ p.order_no }}（{{ p.device_code }} · {{ p.mode_name }}）</span></div>
          <div class="proxy-line"><span>代取人 / 时间</span><span>{{ p.cleaner_name }} · {{ fmtTime(p.collected_at) }}</span></div>
          <template v-if="p.status === 'stored'">
            <div class="proxy-line">
              <span>保管期限（{{ p.storage_hours }} 小时）</span>
              <b :style="{ color: storeRemain(p) ? 'var(--amber)' : 'var(--red)' }">
                {{ storeRemain(p) ? `剩余 ${storeRemain(p)}` : '已到期' }}
              </b>
            </div>
            <div class="alert info" style="font-size:12px">
              保管至 {{ fmtTime(p.store_until) }}，逾期将移交物业进入遗留物流程。取回时请核对封袋编号并扫码确认。
            </div>
            <div class="pickup-code">{{ p.pickup_code }}</div>
            <div class="muted" style="text-align:center;font-size:12px">取件码（柜面扫码或手动输入）</div>
            <button class="btn btn-primary btn-block" @click="openConfirm(p)">✅ 核对取回</button>
          </template>
          <template v-else-if="p.status === 'returned'">
            <div class="proxy-line"><span>取回时间</span><span>{{ fmtTime(p.returned_at) }}</span></div>
          </template>
          <template v-else-if="p.status === 'escalated'">
            <div class="alert error" style="font-size:12px">
              已超过保管期限（{{ fmtTime(p.escalated_at) }} 移交物业），衣物进入遗留物流程，请在「遗留物」标签页申请认领。
            </div>
          </template>
          <template v-else>
            <div class="proxy-line"><span>处置时间</span><span>{{ fmtTime(p.disposed_at) }}</span></div>
          </template>
        </div>
      </div>
      <div v-else class="empty">暂无代取任务</div>
    </div>

    <div v-if="tab === 'credit'" class="card">
      <div class="card-title">信用档案 <span class="sub">按时取衣加分，超时/错拿/恶意占用扣分</span></div>
      <table class="table" v-if="credits.length">
        <thead><tr><th>时间</th><th>变动</th><th>余额</th><th>原因</th></tr></thead>
        <tbody>
          <tr v-for="c in credits" :key="c.id">
            <td class="muted">{{ fmtTime(c.created_at) }}</td>
            <td :style="{ color: c.delta >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 800 }">
              {{ c.delta >= 0 ? '+' : '' }}{{ c.delta }}
            </td>
            <td>{{ c.balance }}</td>
            <td>{{ c.reason }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无信用记录</div>
    </div>

    <div v-if="tab === 'lost'" class="card">
      <div class="card-title">遗留物保管 <span class="sub">超时代收 / 错拿找回的衣物在此认领</span></div>
      <table class="table" v-if="lostItems.length">
        <thead><tr><th>物品</th><th>门店 / 设备</th><th>保管点</th><th>状态</th><th>登记时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="l in lostItems" :key="l.id">
            <td>{{ l.description }}</td>
            <td>{{ l.site_name }} {{ l.device_code }}</td>
            <td>{{ l.keeper || '—' }}</td>
            <td><span class="badge soft">{{ LOST_STATUS[l.status] }}</span></td>
            <td class="muted">{{ fmtTime(l.created_at) }}</td>
            <td>
              <button v-if="l.status === 'stored'" class="btn btn-primary btn-sm" @click="claim(l)">认领</button>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无遗留物记录</div>
    </div>

    <div v-if="tab === 'refund'" class="card">
      <div class="card-title">退款记录</div>
      <table class="table" v-if="refunds.length">
        <thead><tr><th>订单</th><th>设备</th><th>金额</th><th>原因</th><th>状态</th><th>申请时间</th></tr></thead>
        <tbody>
          <tr v-for="r in refunds" :key="r.id">
            <td style="font-weight:700">{{ r.order_no }}</td>
            <td>{{ r.device_code }}</td>
            <td>{{ fen(r.amount_cents) }}</td>
            <td>{{ r.reason }}</td>
            <td><span class="badge" :class="r.status === 'paid' ? 'st-idle' : r.status === 'rejected' ? 'st-fault' : 'st-queued'">{{ REFUND_STATUS[r.status] }}</span></td>
            <td class="muted">{{ fmtTime(r.requested_at) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无退款记录</div>
    </div>

    <!-- 取回确认弹窗：核对封袋编号 + 扫码 -->
    <Modal v-if="confirmTask" :title="`取回确认 · 封袋 ${confirmTask.bag_no}`" @close="confirmTask = null">
      <div class="alert info">
        请到 <b>{{ confirmTask.cabinet_no }} 柜</b>（{{ confirmTask.site_name }}）取回衣物：
        先核对袋面封袋编号，再扫描柜面二维码（或输入取件码）确认。
      </div>
      <div class="field">
        <label>① 核对封袋编号（输入袋面印刷的编号）</label>
        <input class="input" v-model="inputBagNo" :placeholder="`应为 ${confirmTask.bag_no}`" />
      </div>
      <div class="field">
        <label>② 扫码确认（输入 6 位取件码）</label>
        <input class="input" v-model="inputCode" placeholder="取件码见短信 / 上方任务卡" maxlength="6" />
      </div>
      <button class="btn btn-primary btn-block" :disabled="confirming || !inputBagNo || !inputCode" @click="submitConfirm">
        {{ confirming ? '核对中…' : '确认取回' }}
      </button>
      <p class="muted mt8" style="text-align:center">封袋编号或取件码不符将无法确认，防止错拿</p>
    </Modal>
  </div>
</template>
