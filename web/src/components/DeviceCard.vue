<script setup lang="ts">
import { computed } from 'vue';
import type { Device } from '../types';
import { DEVICE_STATUS, fen, fmtTime, remainText, overdueText } from '../utils';

const props = defineProps<{ device: Device; now: number; nightNow: boolean }>();
const emit = defineEmits<{ (e: 'book', d: Device): void }>();

const st = computed(() => DEVICE_STATUS[props.device.status]);
const remain = computed(() => {
  const o = props.device.current_order;
  if (!o) return null;
  if (o.status === 'running') return remainText(o.ends_at, props.now);
  return null;
});
const pickupRemain = computed(() => {
  const o = props.device.current_order;
  if (!o || o.status !== 'finished') return null;
  return remainText(o.pickup_deadline, props.now);
});
const pickupOverdue = computed(() => {
  const o = props.device.current_order;
  if (!o || o.status !== 'finished') return null;
  return overdueText(o.pickup_deadline, props.now);
});
const detergentCls = computed(() =>
  props.device.detergent_level < 20 ? 'meter low' : props.device.detergent_level < 50 ? 'meter mid' : 'meter'
);
const bookable = computed(() => !['fault', 'maintenance', 'offline'].includes(props.device.status));
</script>

<template>
  <div class="device-card" :class="`st-border-${device.status}`">
    <div class="device-head">
      <div class="device-code">
        <span class="device-icon">{{ device.type === 'washer' ? '🧺' : '🌬️' }}</span>
        {{ device.code }}
        <span v-if="device.silent" class="badge night" title="静音机型，夜间可用">🔇 静音</span>
      </div>
      <span class="badge" :class="st.cls">{{ st.label }}</span>
    </div>

    <div class="device-meta">
      <span class="badge soft">{{ device.type === 'washer' ? '洗衣机' : '烘干机' }} · {{ device.capacity_kg }}kg</span>
      <span class="badge soft">{{ device.zone_name }}</span>
      <span v-if="nightNow && !device.silent" class="badge night">夜间静音时段</span>
    </div>

    <!-- 当前占用 / 排队 -->
    <div v-if="device.current_order" class="device-now">
      <div v-if="device.current_order.status === 'running'">
        <b>{{ device.current_order.mine ? '我的订单' : device.current_order.user_name }}</b>
        · {{ device.current_order.mode_name }}
        <template v-if="remain"> · 剩余 <b>{{ remain }}</b></template>
      </div>
      <div v-else-if="device.current_order.status === 'finished'">
        <b>{{ device.current_order.mine ? '我的订单' : device.current_order.user_name }}</b> 待取衣
        <template v-if="pickupRemain"> · 取衣倒计时 <b>{{ pickupRemain }}</b></template>
        <template v-else-if="pickupOverdue"> · <b style="color:var(--red)">已超时 {{ pickupOverdue }}</b></template>
      </div>
      <div class="muted">单号 {{ device.current_order.order_no }}</div>
    </div>
    <div v-else class="device-now">
      <template v-if="device.status === 'idle'">设备空闲，可直接预约使用</template>
      <template v-else-if="device.status === 'queued'">已有 {{ device.queue_count }} 人支付排队</template>
      <template v-else-if="device.status === 'fault'">设备故障，维修处理中</template>
      <template v-else-if="device.status === 'maintenance'">设备计划性维护中</template>
      <template v-else>设备离线，暂不可用</template>
    </div>

    <div v-if="device.queue_count > 0" class="meta-line">
      <span>预约队列</span><b style="color:var(--amber)">{{ device.queue_count }} 人排队</b>
    </div>

    <!-- 洗衣液 / 消毒 / 保洁 -->
    <div>
      <div class="meta-line"><span>洗衣液余量</span><span>{{ device.detergent_level }}%</span></div>
      <div class="mt8" :class="detergentCls"><i :style="{ width: device.detergent_level + '%' }"></i></div>
    </div>
    <div class="meta-line"><span>最近消毒</span><span>{{ fmtTime(device.disinfected_at) }}</span></div>
    <div class="meta-line"><span>最近保洁</span><span>{{ fmtTime(device.last_cleaned_at) }}</span></div>
    <div v-if="device.last_inspection" class="meta-line">
      <span>巡检（{{ device.last_inspection.cleaner_name }}）</span>
      <span>地面{{ device.last_inspection.floor_status }} · 异味{{ device.last_inspection.odor_status }}</span>
    </div>

    <!-- 价格 -->
    <div class="mode-list">
      <div v-for="m in device.modes" :key="m.id" class="mode-item" style="cursor:default">
        <span>{{ m.name }}<span class="muted"> · {{ m.duration_min }}分钟</span></span>
        <span class="price">{{ fen(m.price_cents) }}</span>
      </div>
    </div>

    <button class="btn btn-primary btn-block" :disabled="!bookable" @click="emit('book', device)">
      {{ bookable ? '扫码预约 / 下单' : '暂停服务' }}
    </button>
  </div>
</template>
