<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';
import type { Inspection, LostItem, Site } from '../types';
import { fen, fmtTime, LOST_STATUS } from '../utils';
import { ok, err } from '../toast';

interface Tasks {
  lowDevices: { id: number; code: string; detergent_level: number; site_name: string }[];
  overdueOrders: { id: number; order_no: string; user_name: string; device_code: string; site_name: string; pickup_deadline: string }[];
  auths: { id: number; order_id: number; order_no: string; user_name: string; device_code: string; site_name: string }[];
}

const sites = ref<Site[]>([]);
const tasks = ref<Tasks>({ lowDevices: [], overdueOrders: [], auths: [] });
const inspections = ref<Inspection[]>([]);
const restocks = ref<any[]>([]);
const lostItems = ref<LostItem[]>([]);

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

async function collect(o: { id: number; order_no: string }) {
  const description = prompt('代收物品描述', '遗留衣物一袋') || '遗留衣物一袋';
  try {
    await api.post(`/api/orders/${o.id}/collect-overtime`, { description });
    ok('已代收并存入遗留物柜，设备已释放');
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

onMounted(load);
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
        <div class="card-title">⏰ 超时未取待代收</div>
        <div v-if="tasks.overdueOrders.length">
          <div v-for="o in tasks.overdueOrders" :key="o.id" class="spread" style="padding:7px 0;border-bottom:1px solid var(--line)">
            <span><b>{{ o.device_code }}</b> · {{ o.user_name }}<br />
              <span class="muted">{{ o.order_no }} · 宽限于 {{ fmtTime(o.pickup_deadline) }}</span>
            </span>
            <button class="btn btn-red btn-sm" @click="collect(o)">代收</button>
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
  </div>
</template>
