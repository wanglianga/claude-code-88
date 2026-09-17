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

/** 模拟发送短信（写 sms_logs 留档，返回记录） */
export async function sendSms(userId, kind, content, refType = null, refId = null) {
  const u = await one('SELECT phone FROM users WHERE id=$1', [userId]);
  const r = await q(
    'INSERT INTO sms_logs(user_id, phone, kind, content, ref_type, ref_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [userId, u?.phone || '', kind, content, refType, refId]
  );
  console.log(`[sms] → ${u?.phone || userId} [${kind}] ${content}`);
  return r.rows[0];
}

/**
 * 保洁代取资格判断：根据 取衣倒计时 / 超时提醒短信 / 排队人数 三项条件决定是否允许代取。
 * 1. 倒计时：订单已超时（取衣宽限倒计时结束）；
 * 2. 短信：超时提醒短信已发送且已过 rules.smsGraceMin 分钟（默认 10），给用户留响应时间；
 * 3. 排队：设备有人排队 → 短信条件满足即可代取；无人排队 → 需超时满 rules.proxyExtraWaitMin 分钟（默认 30）。
 * 返回 { eligible, checks:[{key,label,ok,detail}] }
 */
export function proxyEligibility(order, rules, queueCount, smsSentAt, now = new Date()) {
  const smsGraceMin = rules?.smsGraceMin ?? 10;
  const extraWaitMin = rules?.proxyExtraWaitMin ?? 30;
  const checks = [];

  // 条件 1：取衣倒计时已结束
  const overdueMs = order.pickup_deadline ? now - new Date(order.pickup_deadline) : 0;
  const timeoutOk = overdueMs > 0;
  checks.push({
    key: 'countdown',
    label: '取衣倒计时已结束',
    ok: timeoutOk,
    detail: timeoutOk ? `已超时 ${Math.floor(overdueMs / 60000)} 分钟` : '仍在取衣宽限内',
  });

  // 条件 2：超时提醒短信已发出且等待期已满
  const smsWaitOk = !!smsSentAt && now - new Date(smsSentAt) >= smsGraceMin * 60000;
  checks.push({
    key: 'sms',
    label: `超时短信已提醒满 ${smsGraceMin} 分钟`,
    ok: smsWaitOk,
    detail: !smsSentAt
      ? '超时提醒短信尚未发送'
      : smsWaitOk
        ? `短信已于 ${new Date(smsSentAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 发出`
        : `短信已发出，等待用户响应（满 ${smsGraceMin} 分钟可代取）`,
  });

  // 条件 3：排队人数 —— 有人排队可即时代取；无人排队需超时更久
  const queueOk = queueCount >= 1 || overdueMs >= extraWaitMin * 60000;
  checks.push({
    key: 'queue',
    label: queueCount >= 1 ? `设备有 ${queueCount} 人排队` : `无人排队需超时满 ${extraWaitMin} 分钟`,
    ok: queueOk,
    detail: queueCount >= 1
      ? '排队用户等待设备，可代取释放'
      : queueOk
        ? `已超时 ${Math.floor(overdueMs / 60000)} 分钟，达到占机处理阈值`
        : `当前无人排队，超时满 ${extraWaitMin} 分钟才允许代取`,
  });

  return { eligible: checks.every((c) => c.ok), checks };
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
