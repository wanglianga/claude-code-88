<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import type { CreditRecord, LostItem, Notification, Package, ProxyPickup, Refund } from '../types';
import { fen, fmtTime, remainText, LOST_STATUS, PROXY_STATUS, REFUND_STATUS } from '../utils';
import { ok, err } from '../toast';
import ProxyConfirmModal from '../components/ProxyConfirmModal.vue';

const auth = useAuthStore();
const packages = ref<Package[]>([]);
const credits = ref<CreditRecord[]>([]);
const lostItems = ref<LostItem[]>([]);
const refunds = ref<Refund[]>([]);
const proxyTasks = ref<ProxyPickup[]>([]);
const confirmTask = ref<ProxyPickup | null>(null);
const now = ref(Date.now());
const tab = ref<'notif' | 'credit' | 'proxy' | 'lost' | 'refund'>('notif');

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
  proxyTasks.value = px;
  now.value = Date.now();
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

async function readAll() {
  await auth.readAll();
}

onMounted(load);
</script>

<template>
  <div class="container">
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
      <div class="tab" :class="{ active: tab === 'credit' }" @click="tab = 'credit'">信用档案</div>
      <div class="tab" :class="{ active: tab === 'proxy' }" @click="tab = 'proxy'">
        代取任务 <span v-if="proxyTasks.filter((t) => t.status === 'stored').length" class="badge st-queued">{{ proxyTasks.filter((t) => t.status === 'stored').length }}</span>
      </div>
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

    <div v-if="tab === 'proxy'" class="card">
      <div class="card-title">代取确认任务 <span class="sub">保洁代取封袋的衣物，取回时需核对封袋编号并扫码确认</span></div>
      <table class="table" v-if="proxyTasks.length">
        <thead><tr><th>封袋编号</th><th>存放柜</th><th>门店 / 设备</th><th>关联订单</th><th>保管期限</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="t in proxyTasks" :key="t.id">
            <td style="font-weight:700">{{ t.bag_no }}</td>
            <td><span class="badge st-queued">{{ t.cabinet_no }}</span></td>
            <td>{{ t.site_name }} {{ t.device_code }}</td>
            <td class="muted">{{ t.order_no }}</td>
            <td>
              <template v-if="t.status === 'stored'">
                <span v-if="remainText(t.keep_until, now)" class="badge soft">剩余 {{ remainText(t.keep_until, now) }}</span>
                <span v-else class="badge st-fault">已逾期</span>
                <div class="muted" style="font-size:12px">至 {{ fmtTime(t.keep_until) }}</div>
              </template>
              <span v-else class="muted">{{ fmtTime(t.keep_until) }} 止</span>
            </td>
            <td><span class="badge" :class="PROXY_STATUS[t.status]?.cls">{{ PROXY_STATUS[t.status]?.label }}</span></td>
            <td>
              <button v-if="t.status === 'stored'" class="btn btn-green btn-sm" @click="confirmTask = t">核对取回</button>
              <span v-else-if="t.status === 'escalated'" class="muted" style="font-size:12px">已转遗留物，请到「遗留物」认领</span>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无代取记录</div>
      <p class="muted mt8" v-if="proxyTasks.length">提示：保管期限内未取回的衣物将移交物业按遗留物处理并扣减信用。</p>
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

    <!-- 代取衣物核对取回弹窗 -->
    <ProxyConfirmModal v-if="confirmTask" :task="confirmTask" @close="confirmTask = null" @done="load" />
  </div>
</template>
