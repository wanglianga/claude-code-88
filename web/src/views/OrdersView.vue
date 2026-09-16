<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';
import type { Order } from '../types';
import { ORDER_STATUS, PAY_STATUS, fen, fmtTime } from '../utils';
import { ok, err } from '../toast';
import Modal from '../components/Modal.vue';

const orders = ref<Order[]>([]);
const reportOrder = ref<Order | null>(null);
const reportType = ref('refund_request');
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

async function load() {
  orders.value = await api.get<Order[]>('/api/orders/mine');
}

function openReport(o: Order, type = 'other') {
  reportOrder.value = o;
  reportType.value = type;
  reportDesc.value = '';
}

async function submitReport() {
  if (!reportOrder.value) return;
  try {
    await api.post(`/api/orders/${reportOrder.value.id}/report`, { type: reportType.value, description: reportDesc.value });
    ok('已提交，可在「我的工单」跟踪处理进度');
    reportOrder.value = null;
  } catch (e: any) { err(e.message); }
}

onMounted(load);
</script>

<template>
  <div class="container">
    <div class="card">
      <div class="card-title">我的订单 <span class="sub">支付、设备编号、洗涤程序、取衣与退款记录</span></div>
      <table class="table" v-if="orders.length">
        <thead>
          <tr>
            <th>订单号</th><th>门店 / 设备</th><th>程序</th><th>金额</th><th>支付</th><th>状态</th><th>时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="o in orders" :key="o.id">
            <td style="font-weight:700">{{ o.order_no }}</td>
            <td>{{ o.site_name }}<br /><b>{{ o.device_code }}</b></td>
            <td>{{ o.mode_name }}</td>
            <td>
              {{ fen(o.amount_cents) }}
              <div v-if="o.discount_cents > 0" class="muted">优惠 {{ fen(o.discount_cents) }}</div>
            </td>
            <td>{{ PAY_STATUS[o.pay_status] || o.pay_status }}</td>
            <td>
              <span class="badge" :class="ORDER_STATUS[o.status]?.cls">{{ ORDER_STATUS[o.status]?.label || o.status }}</span>
              <div v-if="o.overdue" class="badge st-fault" style="margin-top:3px">超时</div>
            </td>
            <td class="muted" style="font-size:12px">
              预约 {{ fmtTime(o.booked_at) }}<br />
              <template v-if="o.finished_at">完成 {{ fmtTime(o.finished_at) }}</template>
            </td>
            <td>
              <div class="row" style="gap:6px">
                <button v-if="['paid','running','finished'].includes(o.status)" class="btn btn-outline btn-sm" @click="openReport(o)">上报问题</button>
                <button v-if="o.pay_status === 'paid' && o.status !== 'closed'" class="btn btn-ghost btn-sm" @click="openReport(o, 'refund_request')">申请退款</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无订单，去「设备预约」下一单吧</div>
    </div>

    <Modal v-if="reportOrder" :title="`订单 ${reportOrder.order_no} · 上报问题`" @close="reportOrder = null">
      <div class="field">
        <label>问题类型</label>
        <select class="select" v-model="reportType">
          <option v-for="o in REPORT_OPTIONS" :key="o.v" :value="o.v">{{ o.t }}</option>
        </select>
      </div>
      <div class="field">
        <label>问题描述</label>
        <textarea class="textarea" v-model="reportDesc" placeholder="请描述具体情况"></textarea>
      </div>
      <button class="btn btn-primary btn-block" @click="submitReport">提交</button>
    </Modal>
  </div>
</template>
