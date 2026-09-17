import jwt from 'jsonwebtoken';
import { one, many, q } from './db.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export function signToken(user) {
  return jwt.sign({ uid: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '12h' });
}

/** 认证中间件：解析 Bearer Token，挂载 req.user */
export async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await one('SELECT id, username, name, role, phone, credit, package_id, package_expires_at, free_washes FROM users WHERE id=$1', [payload.uid]);
    if (!user) return res.status(401).json({ error: '账号不存在' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期' });
  }
}

/** 角色限制 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: '无权限' });
    next();
  };
}

export function genNo(prefix) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${prefix}${ymd}${Math.floor(100000 + Math.random() * 900000)}`;
}

/** 发送站内通知 */
export async function notify(userId, type, title, body = '') {
  await q('INSERT INTO notifications(user_id, type, title, body) VALUES($1,$2,$3,$4)', [userId, type, title, body]);
}

/** 调整用户信用分并留档 */
export async function adjustCredit(client, userId, delta, reason, refType = null, refId = null) {
  const r = await client.query('UPDATE users SET credit = GREATEST(0, LEAST(120, credit + $1)) WHERE id=$2 RETURNING credit', [delta, userId]);
  const balance = r.rows[0]?.credit ?? 0;
  await client.query('INSERT INTO credit_records(user_id, delta, balance, reason, ref_type, ref_id) VALUES($1,$2,$3,$4,$5,$6)', [userId, delta, balance, reason, refType, refId]);
  return balance;
}

/** 工单时间线事件 */
export async function ticketEvent(client, ticketId, actor, action, note = '') {
  await client.query('INSERT INTO ticket_events(ticket_id, actor_id, actor_name, action, note) VALUES($1,$2,$3,$4,$5)', [ticketId, actor?.id || null, actor?.name || '系统', action, note]);
}

/** 创建工单（可在事务内使用） */
export async function createTicket(client, { type, orderId = null, deviceId = null, siteId = null, title, description = '', priority = 'normal', raisedBy = null, assignedRole = null }) {
  const no = genNo('TK');
  const r = await client.query(
    `INSERT INTO tickets(ticket_no, type, order_id, device_id, site_id, title, description, priority, raised_by, assigned_role)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [no, type, orderId, deviceId, siteId, title, description, priority, raisedBy, assignedRole]
  );
  const t = r.rows[0];
  await ticketEvent(client, t.id, null, 'create', `工单创建：${title}`);
  return t;
}

/**
 * 计算价格：模式价 × 峰谷系数 × 会员折扣。
 * rules.peakPricing: [{start:'18:00',end:'22:00',multiplier:1.2,label:'晚高峰'}]
 * rules.offPeak: [{start:'08:00',end:'11:00',multiplier:0.8,label:'错峰优惠'}]
 */
export function calcPrice(modePriceCents, rules, user, now = new Date()) {
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const inRange = (r) => (r.start <= r.end ? hhmm >= r.start && hhmm < r.end : hhmm >= r.start || hhmm < r.end);
  let multiplier = 1;
  let multiplierLabel = null;
  for (const p of rules.peakPricing || []) {
    if (inRange(p)) { multiplier = p.multiplier; multiplierLabel = p.label || '高峰加价'; break; }
  }
  if (multiplier === 1) {
    for (const p of rules.offPeak || []) {
      if (inRange(p)) { multiplier = p.multiplier; multiplierLabel = p.label || '错峰优惠'; break; }
    }
  }
  const afterMultiplier = Math.round(modePriceCents * multiplier);
  let discountPct = 100;
  let memberLabel = null;
  if (user.package_id && user.package_expires_at && new Date(user.package_expires_at) > now) {
    discountPct = user.discount_pct || 100;
    memberLabel = user.package_name ? `会员「${user.package_name}」${discountPct / 10}折` : '会员折扣';
  }
  const amount = Math.round((afterMultiplier * discountPct) / 100);
  return {
    base: modePriceCents,
    multiplier,
    multiplierLabel,
    afterMultiplier,
    discountPct,
    memberLabel,
    amount,
    discount: afterMultiplier - amount,
  };
}

/** 当前是否处于夜间静音时段 */
export function inNightSilent(rules, now = new Date()) {
  const ns = rules.nightSilent;
  if (!ns || !ns.enabled) return false;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return ns.start <= ns.end ? hhmm >= ns.start && hhmm < ns.end : hhmm >= ns.start || hhmm < ns.end;
}

/** 设备当前生效订单（running / finished 占用中） */
export async function activeOrderOfDevice(deviceId) {
  return one(
    `SELECT * FROM orders WHERE device_id=$1 AND status IN ('running','finished') ORDER BY id DESC LIMIT 1`,
    [deviceId]
  );
}

/**
 * 保洁代取资格评估：页面根据「倒计时 / 短信提醒 / 排队人数」决定是否允许代取。
 * - 倒计时：取衣宽限倒计时已结束（订单已超时）；
 * - 短信提醒：系统已至少发送 1 次短信提醒用户取衣；
 * - 排队人数：设备有人排队等机，或无人排队但超时时长已达门店代取宽限（rules.proxyCollectAfterMin，默认 15 分钟）。
 * 三者同时满足才允许保洁拍照封袋代取。
 */
export function proxyEligibility(order, queueCount, rules = {}, now = new Date()) {
  const deadline = order.pickup_deadline ? new Date(order.pickup_deadline) : null;
  const overdueMin = deadline ? Math.max(0, Math.floor((now.getTime() - deadline.getTime()) / 60000)) : 0;
  const overdue = !!order.overdue || overdueMin > 0;
  const smsCount = order.sms_count || 0;
  const afterMin = rules.proxyCollectAfterMin ?? 15;
  const checks = {
    overdue,
    overdueMin,
    smsCount,
    smsOk: smsCount >= 1,
    queueCount,
    queueOk: queueCount > 0 || overdueMin >= afterMin,
    afterMin,
  };
  const canProxy = checks.overdue && checks.smsOk && checks.queueOk;
  let reason = '';
  if (!checks.overdue) reason = '取衣倒计时未结束';
  else if (!checks.smsOk) reason = '尚未发送短信提醒';
  else if (!checks.queueOk) reason = `无人排队且超时未满 ${afterMin} 分钟`;
  return { ...checks, canProxy, reason };
}

/** 设备排队队列（已支付待启动） */
export async function queueOfDevice(deviceId) {
  return many(
    `SELECT o.id, o.order_no, o.user_id, o.mode_name, o.paid_at, u.name AS user_name
     FROM orders o JOIN users u ON u.id=o.user_id
     WHERE o.device_id=$1 AND o.status='paid' ORDER BY o.paid_at ASC`,
    [deviceId]
  );
}

/**
 * 占用释放后重算设备队列（取衣/代收/取消/退款关闭订单后调用）：
 * - 设备仍被进行中/待取订单占用 → 保持 running/finished，不提前通知下一位；
 * - 设备空闲且队列有下一位 → 置 queued 并通知其启动；
 * - 队列已空 → 置 idle。
 * 故障/维修/离线设备不改动。
 */
export async function notifyNextInQueue(client, deviceId) {
  const active = await client.query(
    `SELECT id FROM orders WHERE device_id=$1 AND status IN ('running','finished') LIMIT 1`,
    [deviceId]
  );
  if (active.rows[0]) return;
  const next = await client.query(
    `SELECT o.id, o.user_id, o.order_no, d.code AS device_code FROM orders o JOIN devices d ON d.id=o.device_id
     WHERE o.device_id=$1 AND o.status='paid' ORDER BY o.paid_at ASC LIMIT 1`,
    [deviceId]
  );
  if (next.rows[0]) {
    const n = next.rows[0];
    await client.query(`UPDATE devices SET status='queued' WHERE id=$1 AND status NOT IN ('fault','maintenance','offline')`, [deviceId]);
    await notify(n.user_id, 'queue', '轮到你了', `设备 ${n.device_code} 已空闲，你的订单 ${n.order_no} 可以启动，请尽快前往。`);
  } else {
    await client.query(`UPDATE devices SET status='idle' WHERE id=$1 AND status NOT IN ('fault','maintenance','offline')`, [deviceId]);
  }
}
