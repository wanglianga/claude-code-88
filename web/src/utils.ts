import type { DeviceStatus, Role } from './types';

export const fen = (c: number) => `¥${(c / 100).toFixed(2)}`;

export function fmtTime(s?: string | null) {
  if (!s) return '—';
  const d = new Date(s);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 剩余时间文本（目标时间 - now），超时返回 null */
export function remainText(target?: string | null, now = Date.now()): string | null {
  if (!target) return null;
  const ms = new Date(target).getTime() - now;
  if (ms <= 0) return null;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (m >= 60) return `${Math.floor(m / 60)}小时${m % 60}分`;
  return `${m}分${String(s).padStart(2, '0')}秒`;
}

export function overdueText(target?: string | null, now = Date.now()): string | null {
  if (!target) return null;
  const ms = now - new Date(target).getTime();
  if (ms <= 0) return null;
  const m = Math.floor(ms / 60000);
  if (m >= 60) return `${Math.floor(m / 60)}小时${m % 60}分`;
  return `${m}分钟`;
}

export const DEVICE_STATUS: Record<DeviceStatus, { label: string; cls: string }> = {
  idle: { label: '空闲', cls: 'st-idle' },
  queued: { label: '排队中', cls: 'st-queued' },
  running: { label: '运行中', cls: 'st-running' },
  finished: { label: '待取衣', cls: 'st-finished' },
  fault: { label: '故障', cls: 'st-fault' },
  maintenance: { label: '维修中', cls: 'st-maint' },
  offline: { label: '离线', cls: 'st-offline' },
};

export const ORDER_STATUS: Record<string, { label: string; cls: string }> = {
  booked: { label: '待支付', cls: 'st-queued' },
  paid: { label: '已支付·排队中', cls: 'st-queued' },
  running: { label: '洗涤中', cls: 'st-running' },
  finished: { label: '待取衣', cls: 'st-finished' },
  closed: { label: '已完成', cls: 'st-idle' },
  cancelled: { label: '已取消', cls: 'st-offline' },
  expired: { label: '超时已代收', cls: 'st-fault' },
};

export const TICKET_STATUS: Record<string, { label: string; cls: string }> = {
  open: { label: '待处理', cls: 'st-fault' },
  assigned: { label: '已指派', cls: 'st-queued' },
  processing: { label: '处理中', cls: 'st-running' },
  resolved: { label: '已解决', cls: 'st-idle' },
  closed: { label: '已关闭', cls: 'st-offline' },
};

export const TICKET_TYPES: Record<string, string> = {
  mid_stop: '设备中途停机',
  dryer_not_dry: '烘干不干',
  detergent_low: '洗衣液不足',
  wrong_pickup: '衣物错拿申诉',
  door_stuck: '门锁打不开',
  refund_request: '退款申请',
  timeout_no_pickup: '超时未取',
  noise: '噪声投诉',
  dispute: '物业纠纷',
  device_fault: '设备故障',
  other: '其他问题',
};

export const ROLE_LABEL: Record<Role, string> = {
  resident: '居民', service: '客服', cleaner: '保洁', maintenance: '维修', property: '物业',
};

export const SITE_KIND: Record<string, string> = {
  dorm: '宿舍', apartment: '公寓', old_community: '老旧小区',
};

export const PAY_STATUS: Record<string, string> = {
  unpaid: '未支付', paid: '已支付', refunded: '已退款', partial_refunded: '部分退款',
};

export const LOST_STATUS: Record<string, string> = {
  stored: '保管中', claimed: '认领中', returned: '已归还', disposed: '已处理',
};

export const REFUND_STATUS: Record<string, string> = {
  requested: '待审核', approved: '已批准', rejected: '已驳回', paid: '已退款',
};
