<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import type { Site } from '../types';
import { DEVICE_STATUS, SITE_KIND, TICKET_TYPES, fen, fmtTime, LOST_STATUS, PROXY_STATUS, REFUND_STATUS } from '../utils';
import { ok, err } from '../toast';

const sites = ref<Site[]>([]);
const siteId = ref(0);
const overview = ref<any>(null);
const suggestions = ref<{ level: string; title: string; detail: string }[]>([]);
const archives = ref<any>({ refunds: [], repairs: [], wrongPickups: [], lostItems: [], credits: [], proxyPickups: [] });
const users = ref<any[]>([]);
const zones = ref<any[]>([]);
const tab = ref<'stats' | 'rules' | 'archives' | 'users'>('stats');

// 规则编辑
const rulesForm = ref<any>({});
// 新增设备
const newDevice = ref({ zone_id: 0, code: '', type: 'washer', capacity_kg: 8, silent: false });
// 信用调整
const creditForm = ref({ user_id: 0, delta: 0, reason: '' });

const site = computed(() => sites.value.find((s) => s.id === siteId.value));

async function loadSites() {
  sites.value = await api.get<Site[]>('/api/sites');
  if (sites.value.length && !siteId.value) siteId.value = sites.value[0].id;
}

async function loadAll() {
  if (!siteId.value) return;
  const [o, s, a, u, b] = await Promise.all([
    api.get<any>(`/api/stats/overview?site_id=${siteId.value}`),
    api.get<any>(`/api/stats/suggestions?site_id=${siteId.value}`),
    api.get<any>(`/api/archives?site_id=${siteId.value}`),
    api.get<any[]>('/api/users'),
    api.get<any>(`/api/sites/${siteId.value}/board`),
  ]);
  overview.value = o;
  suggestions.value = s.suggestions;
  archives.value = a;
  users.value = u;
  zones.value = b.zones;
  const r = site.value?.rules || {};
  rulesForm.value = {
    nightSilent: { enabled: r.nightSilent?.enabled ?? true, start: r.nightSilent?.start ?? '22:00', end: r.nightSilent?.end ?? '07:00' },
    allowNightStart: r.allowNightStart ?? false,
    pickupGraceMin: r.pickupGraceMin ?? 30,
    proxyCollectAfterMin: r.proxyCollectAfterMin ?? 15,
    proxyKeepHours: r.proxyKeepHours ?? 48,
    maxDailyOrdersPerUser: r.maxDailyOrdersPerUser ?? 4,
    minCreditToBook: r.minCreditToBook ?? 60,
    peakPricing: JSON.parse(JSON.stringify(r.peakPricing?.length ? r.peakPricing : [{ start: '18:00', end: '22:00', multiplier: 1.2, label: '晚高峰加价' }])),
    offPeak: JSON.parse(JSON.stringify(r.offPeak?.length ? r.offPeak : [{ start: '09:00', end: '16:00', multiplier: 0.85, label: '错峰优惠' }])),
    note: r.note ?? '',
  };
}

async function switchSite(id: number) {
  siteId.value = id;
  await loadAll();
}

async function saveRules() {
  try {
    await api.put(`/api/sites/${siteId.value}/rules`, rulesForm.value);
    ok('运营规则已保存并即时生效');
    await loadSites();
  } catch (e: any) { err(e.message); }
}

async function addDevice() {
  try {
    await api.post('/api/devices', { ...newDevice.value, site_id: siteId.value, zone_id: newDevice.value.zone_id || null });
    ok('设备已添加');
    newDevice.value.code = '';
    await loadAll();
  } catch (e: any) { err(e.message); }
}

async function adjustCredit() {
  if (!creditForm.value.user_id || !creditForm.value.delta || !creditForm.value.reason) {
    return err('请完整填写用户、分值与原因');
  }
  try {
    const r = await api.post<{ balance: number }>(`/api/users/${creditForm.value.user_id}/credit`, {
      delta: creditForm.value.delta, reason: creditForm.value.reason,
    });
    ok(`信用已调整，当前 ${r.balance} 分`);
    creditForm.value = { user_id: 0, delta: 0, reason: '' };
    await loadAll();
  } catch (e: any) { err(e.message); }
}

const levelCls = (l: string) => (l === 'high' ? 'st-fault' : l === 'mid' ? 'st-queued' : 'st-idle');
const levelLabel = (l: string) => (l === 'high' ? '优先处理' : l === 'mid' ? '关注' : '提示');

onMounted(async () => {
  await loadSites();
  await loadAll();
});
</script>

<template>
  <div class="container">
    <div class="tabs">
      <div v-for="s in sites" :key="s.id" class="tab" :class="{ active: s.id === siteId }" @click="switchSite(s.id)">
        {{ s.name }}<span class="badge soft" style="margin-left:4px">{{ SITE_KIND[s.kind] }}</span>
      </div>
    </div>

    <div class="tabs" style="margin-top:-6px">
      <div class="tab" :class="{ active: tab === 'stats' }" @click="tab = 'stats'">经营统计</div>
      <div class="tab" :class="{ active: tab === 'rules' }" @click="tab = 'rules'">运营规则</div>
      <div class="tab" :class="{ active: tab === 'archives' }" @click="tab = 'archives'">闭环档案</div>
      <div class="tab" :class="{ active: tab === 'users' }" @click="tab = 'users'">用户与信用</div>
    </div>

    <!-- ============ 经营统计 ============ -->
    <template v-if="tab === 'stats' && overview">
      <div class="grid grid-4">
        <div class="stat-card"><div class="lbl">今日订单</div><div class="num">{{ overview.today.orders }}</div></div>
        <div class="stat-card"><div class="lbl">今日营收</div><div class="num">{{ fen(overview.today.revenue) }}</div></div>
        <div class="stat-card"><div class="lbl">30 天营收</div><div class="num">{{ fen(overview.revenue30) }}</div></div>
        <div class="stat-card"><div class="lbl">开放工单 / 平均排队</div><div class="num">{{ overview.openTickets }} <span style="font-size:14px;color:var(--ink-3)">/ {{ overview.avgWaitMin }}分钟</span></div></div>
      </div>

      <div class="grid grid-2 mt16">
        <div class="card">
          <div class="card-title">设备利用率（近 30 天）</div>
          <div v-for="d in overview.deviceStats" :key="d.id" class="bar-row">
            <span class="name">{{ d.code }} <span class="badge soft" style="font-size:10px">{{ DEVICE_STATUS[d.status as keyof typeof DEVICE_STATUS]?.label }}</span></span>
            <div class="bar"><i :style="{ width: Math.round(d.utilization * 100) + '%' }"></i></div>
            <span class="val">{{ Math.round(d.utilization * 100) }}%</span>
          </div>
        </div>
        <div class="card">
          <div class="card-title">投诉与工单分布（近 30 天）</div>
          <div v-if="overview.ticketsByType.length">
            <div v-for="t in overview.ticketsByType" :key="t.type" class="bar-row">
              <span class="name">{{ TICKET_TYPES[t.type] || t.type }}</span>
              <div class="bar"><i :style="{ width: Math.min(100, t.c * 20) + '%', background: 'linear-gradient(90deg,#dc2626,#f87171)' }"></i></div>
              <span class="val">{{ t.c }} 起</span>
            </div>
          </div>
          <div v-else class="empty">近 30 天无工单</div>
        </div>
      </div>

      <div class="card mt16">
        <div class="card-title">💡 扩容与运营建议 <span class="sub">基于投诉与真实使用率自动生成</span></div>
        <div class="grid grid-2">
          <div v-for="(s, i) in suggestions" :key="i" class="device-now">
            <div class="spread">
              <b>{{ s.title }}</b>
              <span class="badge" :class="levelCls(s.level)">{{ levelLabel(s.level) }}</span>
            </div>
            <p class="muted mt8">{{ s.detail }}</p>
          </div>
        </div>
      </div>

      <div class="card mt16">
        <div class="card-title">＋ 新增设备（扩容执行）</div>
        <div class="row">
          <select class="select" style="max-width:150px" v-model.number="newDevice.zone_id">
            <option :value="0" disabled>选择分区</option>
            <option v-for="z in zones" :key="z.id" :value="z.id">{{ z.name }}</option>
          </select>
          <input class="input" style="max-width:150px" v-model="newDevice.code" placeholder="设备编号 如 QS-W104" />
          <select class="select" style="max-width:120px" v-model="newDevice.type">
            <option value="washer">洗衣机</option><option value="dryer">烘干机</option>
          </select>
          <input class="input" style="max-width:100px" type="number" v-model.number="newDevice.capacity_kg" placeholder="容量kg" />
          <label class="row" style="gap:4px"><input type="checkbox" v-model="newDevice.silent" /> 静音机型</label>
          <button class="btn btn-primary" @click="addDevice">添加设备</button>
        </div>
      </div>
    </template>

    <!-- ============ 运营规则 ============ -->
    <template v-if="tab === 'rules'">
      <div class="card">
        <div class="card-title">门店运营规则 <span class="sub">{{ site?.name }} · 保存后即时生效</span></div>
        <div class="form-row">
          <div class="field">
            <label>夜间静音时段</label>
            <div class="row">
              <label class="row" style="gap:4px"><input type="checkbox" v-model="rulesForm.nightSilent.enabled" /> 启用</label>
              <input class="input" style="max-width:100px" v-model="rulesForm.nightSilent.start" placeholder="22:00" />
              <span>至</span>
              <input class="input" style="max-width:100px" v-model="rulesForm.nightSilent.end" placeholder="07:00" />
            </div>
          </div>
          <div class="field">
            <label>静音时段启动策略</label>
            <select class="select" v-model="rulesForm.allowNightStart">
              <option :value="false">仅静音机型可启动</option>
              <option :value="true">全部机型可启动</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>取衣宽限（分钟，超时扣信用并生成保洁工单）</label>
            <input class="input" type="number" v-model.number="rulesForm.pickupGraceMin" />
          </div>
          <div class="field">
            <label>代取宽限（分钟，无人排队时超时满该时长才允许保洁代取）</label>
            <input class="input" type="number" v-model.number="rulesForm.proxyCollectAfterMin" />
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>代取保管期限（小时，逾期移交物业遗留物）</label>
            <input class="input" type="number" v-model.number="rulesForm.proxyKeepHours" />
          </div>
          <div class="field">
            <label>每日预约上限（单用户，防恶意占用）</label>
            <input class="input" type="number" v-model.number="rulesForm.maxDailyOrdersPerUser" />
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>预约信用门槛（分）</label>
            <input class="input" type="number" v-model.number="rulesForm.minCreditToBook" />
          </div>
          <div class="field">
            <label>规则说明（向居民展示）</label>
            <input class="input" v-model="rulesForm.note" />
          </div>
        </div>

        <div class="section-title">高峰加价（错峰价格）</div>
        <div v-for="(p, i) in rulesForm.peakPricing" :key="'p' + i" class="row" style="margin-bottom:8px">
          <input class="input" style="max-width:100px" v-model="p.start" placeholder="开始" />
          <span>至</span>
          <input class="input" style="max-width:100px" v-model="p.end" placeholder="结束" />
          <input class="input" style="max-width:110px" type="number" step="0.05" v-model.number="p.multiplier" placeholder="系数" />
          <input class="input" style="flex:1" v-model="p.label" placeholder="标签" />
          <button class="btn btn-ghost btn-sm" @click="rulesForm.peakPricing.splice(i, 1)">删除</button>
        </div>
        <button class="btn btn-outline btn-sm" @click="rulesForm.peakPricing.push({ start: '18:00', end: '22:00', multiplier: 1.2, label: '高峰加价' })">＋ 添加高峰时段</button>

        <div class="section-title">错峰优惠</div>
        <div v-for="(p, i) in rulesForm.offPeak" :key="'o' + i" class="row" style="margin-bottom:8px">
          <input class="input" style="max-width:100px" v-model="p.start" placeholder="开始" />
          <span>至</span>
          <input class="input" style="max-width:100px" v-model="p.end" placeholder="结束" />
          <input class="input" style="max-width:110px" type="number" step="0.05" v-model.number="p.multiplier" placeholder="系数" />
          <input class="input" style="flex:1" v-model="p.label" placeholder="标签" />
          <button class="btn btn-ghost btn-sm" @click="rulesForm.offPeak.splice(i, 1)">删除</button>
        </div>
        <button class="btn btn-outline btn-sm" @click="rulesForm.offPeak.push({ start: '09:00', end: '16:00', multiplier: 0.85, label: '错峰优惠' })">＋ 添加错峰时段</button>

        <div class="mt16">
          <button class="btn btn-primary" @click="saveRules">保存规则</button>
        </div>
      </div>
    </template>

    <!-- ============ 闭环档案 ============ -->
    <template v-if="tab === 'archives'">
      <div class="card">
        <div class="card-title">退款档案</div>
        <table class="table" v-if="archives.refunds.length">
          <thead><tr><th>订单</th><th>用户</th><th>设备</th><th>金额</th><th>原因</th><th>状态</th><th>时间</th></tr></thead>
          <tbody>
            <tr v-for="r in archives.refunds" :key="r.id">
              <td style="font-weight:700">{{ r.order_no }}</td><td>{{ r.user_name }}</td><td>{{ r.device_code }}</td>
              <td>{{ fen(r.amount_cents) }}</td><td>{{ r.reason }}</td>
              <td><span class="badge soft">{{ REFUND_STATUS[r.status] }}</span></td>
              <td class="muted">{{ fmtTime(r.requested_at) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">暂无退款记录</div>
      </div>

      <div class="grid grid-2 mt16">
        <div class="card">
          <div class="card-title">维修档案</div>
          <table class="table" v-if="archives.repairs.length">
            <thead><tr><th>设备</th><th>内容</th><th>费用</th><th>技师</th><th>时间</th></tr></thead>
            <tbody>
              <tr v-for="r in archives.repairs" :key="r.id">
                <td style="font-weight:700">{{ r.device_code }}</td><td>{{ r.description }}</td>
                <td>{{ fen(r.cost_cents) }}</td><td>{{ r.technician_name || '—' }}</td>
                <td class="muted">{{ fmtTime(r.created_at) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">暂无维修记录</div>
        </div>

        <div class="card">
          <div class="card-title">错拿申诉档案</div>
          <table class="table" v-if="archives.wrongPickups.length">
            <thead><tr><th>工单</th><th>申诉人</th><th>设备</th><th>状态</th><th>结论</th></tr></thead>
            <tbody>
              <tr v-for="t in archives.wrongPickups" :key="t.id">
                <td style="font-weight:700">{{ t.ticket_no }}</td><td>{{ t.raised_by_name }}</td><td>{{ t.device_code }}</td>
                <td><span class="badge soft">{{ t.status }}</span></td>
                <td class="muted">{{ t.resolution || '处理中' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">暂无错拿申诉</div>
        </div>
      </div>

      <div class="grid grid-2 mt16">
        <div class="card">
          <div class="card-title">遗留物保管档案</div>
          <table class="table" v-if="archives.lostItems.length">
            <thead><tr><th>物品</th><th>设备</th><th>状态</th><th>时间</th></tr></thead>
            <tbody>
              <tr v-for="l in archives.lostItems" :key="l.id">
                <td>{{ l.description }}</td><td>{{ l.device_code }}</td>
                <td><span class="badge soft">{{ LOST_STATUS[l.status] }}</span></td>
                <td class="muted">{{ fmtTime(l.created_at) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">暂无遗留物</div>
        </div>

        <div class="card">
          <div class="card-title">代取保管档案 <span class="sub">超时占机代取全记录</span></div>
          <table class="table" v-if="archives.proxyPickups?.length">
            <thead><tr><th>封袋</th><th>柜</th><th>物主</th><th>保洁</th><th>状态</th><th>时间</th></tr></thead>
            <tbody>
              <tr v-for="p in archives.proxyPickups" :key="p.id">
                <td style="font-weight:700">{{ p.bag_no }}</td>
                <td>{{ p.cabinet_no }}</td>
                <td>{{ p.user_name }}</td>
                <td>{{ p.cleaner_name }}</td>
                <td><span class="badge" :class="PROXY_STATUS[p.status]?.cls">{{ PROXY_STATUS[p.status]?.label }}</span></td>
                <td class="muted">{{ fmtTime(p.created_at) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">暂无代取记录</div>
        </div>
      </div>

      <div class="grid grid-2 mt16">
        <div class="card">
          <div class="card-title">用户信用档案（全部）</div>
          <div style="max-height:320px;overflow-y:auto">
            <table class="table">
              <thead><tr><th>用户</th><th>变动</th><th>余额</th><th>原因</th><th>时间</th></tr></thead>
              <tbody>
                <tr v-for="c in archives.credits" :key="c.id">
                  <td>{{ c.user_name }}</td>
                  <td :style="{ color: c.delta >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }">{{ c.delta >= 0 ? '+' : '' }}{{ c.delta }}</td>
                  <td>{{ c.balance }}</td><td class="muted">{{ c.reason }}</td>
                  <td class="muted">{{ fmtTime(c.created_at) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ 用户与信用 ============ -->
    <template v-if="tab === 'users'">
      <div class="card">
        <div class="card-title">信用调整 <span class="sub">错拿核实、恶意占用、纠纷处理后的信用处置</span></div>
        <div class="row">
          <select class="select" style="max-width:220px" v-model.number="creditForm.user_id">
            <option :value="0" disabled>选择用户</option>
            <option v-for="u in users.filter((x) => x.role === 'resident')" :key="u.id" :value="u.id">
              {{ u.name }}（当前 {{ u.credit }} 分）
            </option>
          </select>
          <input class="input" style="max-width:120px" type="number" v-model.number="creditForm.delta" placeholder="分值 ±" />
          <input class="input" style="flex:1" v-model="creditForm.reason" placeholder="原因，如：错拿他人物品核实属实" />
          <button class="btn btn-primary" @click="adjustCredit">调整</button>
        </div>
      </div>

      <div class="card mt16">
        <div class="card-title">用户列表</div>
        <table class="table">
          <thead><tr><th>用户</th><th>角色</th><th>信用</th><th>会员</th><th>订单数</th><th>超时次数</th><th>免费次数</th></tr></thead>
          <tbody>
            <tr v-for="u in users" :key="u.id">
              <td><b>{{ u.name }}</b><div class="muted">{{ u.username }}</div></td>
              <td>{{ { resident: '居民', service: '客服', cleaner: '保洁', maintenance: '维修', property: '物业' }[u.role as string] }}</td>
              <td><span class="credit-chip" :class="{ low: u.credit < 60 }">{{ u.credit }}</span></td>
              <td>{{ u.package_name || '—' }}</td>
              <td>{{ u.order_count }}</td>
              <td :style="{ color: u.overdue_count > 0 ? 'var(--red)' : 'inherit' }">{{ u.overdue_count }}</td>
              <td>{{ u.free_washes }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
