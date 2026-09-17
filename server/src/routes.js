import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { one, many, q, tx } from './db.js';
import {
  auth, requireRole, signToken, genNo, notify, adjustCredit, ticketEvent,
  createTicket, calcPrice, inNightSilent, activeOrderOfDevice, queueOfDevice, notifyNextInQueue,
  proxyEligibility,
} from './helpers.js';

export const router = Router();
const ah = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: '服务器错误：' + e.message }); });
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

/** 业务校验错误：事务内抛出以触发回滚，路由层捕获后转 4xx（return 会被 tx 提交，不能用于中途失败） */
class BizError extends Error {
  constructor(message, code = 400) { super(message); this.code = code; }
}

/* ================= 健康检查 ================= */
router.get('/health', ah(async (req, res) => {
  await q('SELECT 1');
  res.json({ ok: true, service: 'laundry', time: new Date().toISOString() });
}));

/* ================= 认证 ================= */
router.post('/auth/login', ah(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return bad(res, '请输入用户名和密码');
  const user = await one('SELECT * FROM users WHERE username=$1', [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return bad(res, '用户名或密码错误', 401);
  res.json({ token: signToken(user), user: publicUser(user) });
}));

function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, phone: u.phone, credit: u.credit, package_id: u.package_id, package_expires_at: u.package_expires_at, free_washes: u.free_washes };
}

router.get('/auth/me', auth, ah(async (req, res) => {
  const pkg = req.user.package_id ? await one('SELECT name, discount_pct FROM packages WHERE id=$1', [req.user.package_id]) : null;
  res.json({ ...req.user, package: pkg });
}));

/* ================= 门店 / 设备看板 ================= */
router.get('/sites', auth, ah(async (req, res) => {
  const sites = await many('SELECT * FROM sites ORDER BY id');
  res.json(sites);
}));

router.get('/sites/:id/board', auth, ah(async (req, res) => {
  const site = await one('SELECT * FROM sites WHERE id=$1', [req.params.id]);
  if (!site) return bad(res, '门店不存在', 404);
  const zones = await many('SELECT * FROM zones WHERE site_id=$1 ORDER BY id', [site.id]);
  const devices = await many(
    `SELECT d.*, z.name AS zone_name FROM devices d LEFT JOIN zones z ON z.id=d.zone_id
     WHERE d.site_id=$1 ORDER BY d.code`, [site.id]
  );
  const modes = await many('SELECT * FROM wash_modes ORDER BY id');
  const result = [];
  for (const d of devices) {
    const active = await activeOrderOfDevice(d.id);
    const queue = await queueOfDevice(d.id);
    const lastInspection = await one(
      `SELECT i.*, u.name AS cleaner_name FROM inspections i JOIN users u ON u.id=i.cleaner_id
       WHERE i.site_id=$1 ORDER BY i.created_at DESC LIMIT 1`, [d.site_id]);
    result.push({
      ...d,
      zone_name: d.zone_name || '未分区',
      current_order: active ? {
        order_no: active.order_no, mode_name: active.mode_name, status: active.status,
        ends_at: active.ends_at, finished_at: active.finished_at, pickup_deadline: active.pickup_deadline,
        overdue: active.overdue, user_name: maskName(await userName(active.user_id)), mine: active.user_id === req.user.id, order_id: active.id,
      } : null,
      queue,
      queue_count: queue.length,
      modes: modes.filter((m) => m.device_type === d.type),
      last_inspection: lastInspection,
    });
  }
  res.json({ site, zones, devices: result, night_now: inNightSilent(site.rules) });
}));

function maskName(n) { return n ? n[0] + '*' : ''; }
async function userName(id) { const u = await one('SELECT name FROM users WHERE id=$1', [id]); return u?.name || ''; }

/** 模拟扫码：按设备编码定位设备 */
router.get('/devices/scan/:code', auth, ah(async (req, res) => {
  const d = await one('SELECT id, site_id, code FROM devices WHERE code=$1', [req.params.code.toUpperCase()]);
  if (!d) return bad(res, '未找到该设备，请核对设备编号', 404);
  res.json(d);
}));

router.get('/devices/:id', auth, ah(async (req, res) => {
  const d = await one(`SELECT d.*, z.name AS zone_name, s.name AS site_name, s.rules FROM devices d
    LEFT JOIN zones z ON z.id=d.zone_id JOIN sites s ON s.id=d.site_id WHERE d.id=$1`, [req.params.id]);
  if (!d) return bad(res, '设备不存在', 404);
  const active = await activeOrderOfDevice(d.id);
  const queue = await queueOfDevice(d.id);
  const inspections = await many(
    `SELECT i.*, u.name AS cleaner_name FROM inspections i JOIN users u ON u.id=i.cleaner_id
     WHERE i.site_id=$1 ORDER BY i.created_at DESC LIMIT 5`, [d.site_id]);
  const lostItems = await many(`SELECT id, description, status, created_at FROM lost_items WHERE device_id=$1 ORDER BY id DESC LIMIT 5`, [d.id]);
  const modes = await many('SELECT * FROM wash_modes WHERE device_type=$1 ORDER BY id', [d.type]);
  res.json({ ...d, current_order: active, queue, inspections, lost_items: lostItems, modes, night_now: inNightSilent(d.rules) });
}));

/** 设备回调（模拟 IoT：洗涤完成/门锁故障恢复等） */
router.post('/devices/:id/callback', auth, ah(async (req, res) => {
  const { event } = req.body || {};
  const d = await one('SELECT * FROM devices WHERE id=$1', [req.params.id]);
  if (!d) return bad(res, '设备不存在', 404);
  if (event === 'cycle_finished') {
    const order = await one(`SELECT * FROM orders WHERE device_id=$1 AND status='running' ORDER BY id DESC LIMIT 1`, [d.id]);
    if (!order) return bad(res, '设备当前没有运行中的订单');
    await finishOrder(order, d);
    return res.json({ ok: true, message: `设备 ${d.code} 程序结束，已通知用户取衣` });
  }
  return bad(res, '未知回调事件');
}));

async function finishOrder(order, device) {
  const site = await one('SELECT * FROM sites WHERE id=$1', [order.site_id]);
  const grace = site.rules.pickupGraceMin ?? 30;
  await tx(async (c) => {
    await c.query(
      `UPDATE orders SET status='finished', finished_at=now(), pickup_deadline=now()+($1 || ' minutes')::interval WHERE id=$2`,
      [String(grace), order.id]
    );
    await c.query(`UPDATE devices SET status='finished' WHERE id=$1`, [device.id]);
  });
  await notify(order.user_id, 'finish', '洗涤完成，请及时取衣',
    `设备 ${device.code} 的「${order.mode_name}」已结束，请在 ${grace} 分钟内取衣，超时将产生信用扣减并由保洁代收。`);
}

/* ================= 报价 ================= */
router.get('/quote', auth, ah(async (req, res) => {
  const { device_id, mode_id } = req.query;
  const d = await one('SELECT d.*, s.rules FROM devices d JOIN sites s ON s.id=d.site_id WHERE d.id=$1', [device_id]);
  const m = await one('SELECT * FROM wash_modes WHERE id=$1', [mode_id]);
  if (!d || !m) return bad(res, '参数错误');
  const u = await one(
    `SELECT u.*, p.discount_pct, p.name AS package_name FROM users u LEFT JOIN packages p ON p.id=u.package_id WHERE u.id=$1`,
    [req.user.id]);
  const price = calcPrice(m.price_cents, d.rules, u);
  const canFree = u.free_washes > 0 && m.name.includes('标准洗');
  res.json({ ...price, free_wash_available: canFree, free_washes: u.free_washes });
}));

/* ================= 订单 ================= */
router.post('/orders', auth, requireRole('resident'), ah(async (req, res) => {
  const { device_id, mode_id } = req.body || {};
  const d = await one('SELECT d.*, s.rules, s.name AS site_name FROM devices d JOIN sites s ON s.id=d.site_id WHERE d.id=$1', [device_id]);
  const m = await one('SELECT * FROM wash_modes WHERE id=$1', [mode_id]);
  if (!d || !m) return bad(res, '设备或模式不存在');
  if (m.device_type !== d.type) return bad(res, '该模式不适用于此设备');
  if (['fault', 'maintenance', 'offline'].includes(d.status)) return bad(res, '设备暂停服务，请选择其他设备');

  const rules = d.rules;
  const me = await one('SELECT * FROM users WHERE id=$1', [req.user.id]);
  if (me.credit < (rules.minCreditToBook ?? 60)) return bad(res, `信用分 ${me.credit} 低于本店预约门槛 ${rules.minCreditToBook ?? 60}，请联系物业恢复`, 403);

  const activeMine = await one(`SELECT id FROM orders WHERE user_id=$1 AND status IN ('booked','paid','running','finished')`, [me.id]);
  if (activeMine) return bad(res, '你有进行中的订单，完成后才能再次预约（防止恶意占用）');

  const overdueMine = await one(`SELECT id FROM orders WHERE user_id=$1 AND status='finished' AND overdue=true`, [me.id]);
  if (overdueMine) return bad(res, '你有超时未取的订单，请先处理或联系保洁/客服');

  const todayCount = await one(
    `SELECT count(*)::int AS c FROM orders WHERE user_id=$1 AND booked_at::date=now()::date AND status NOT IN ('cancelled')`, [me.id]);
  if (todayCount.c >= (rules.maxDailyOrdersPerUser ?? 5)) return bad(res, `已达本店每日预约上限（${rules.maxDailyOrdersPerUser} 单）`);

  const u = await one(`SELECT u.*, p.discount_pct, p.name AS package_name FROM users u LEFT JOIN packages p ON p.id=u.package_id WHERE u.id=$1`, [me.id]);
  const price = calcPrice(m.price_cents, rules, u);
  const orderNo = genNo('LD');
  const r = await q(
    `INSERT INTO orders(order_no, user_id, device_id, site_id, mode_id, mode_name, duration_min, price_cents, discount_cents, amount_cents)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [orderNo, me.id, d.id, d.site_id, m.id, m.name, m.duration_min, price.afterMultiplier, price.discount, price.amount]
  );
  res.json({ order: r.rows[0], price });
}));

router.get('/orders/mine', auth, ah(async (req, res) => {
  const rows = await many(
    `SELECT o.*, d.code AS device_code, d.type AS device_type, s.name AS site_name
     FROM orders o JOIN devices d ON d.id=o.device_id JOIN sites s ON s.id=o.site_id
     WHERE o.user_id=$1 ORDER BY o.id DESC LIMIT 50`, [req.user.id]);
  res.json(rows);
}));

router.get('/orders/active', auth, ah(async (req, res) => {
  const o = await one(
    `SELECT o.*, d.code AS device_code, d.type AS device_type, d.silent, s.name AS site_name, s.rules
     FROM orders o JOIN devices d ON d.id=o.device_id JOIN sites s ON s.id=o.site_id
     WHERE o.user_id=$1 AND o.status IN ('booked','paid','running','finished') ORDER BY o.id DESC LIMIT 1`, [req.user.id]);
  if (!o) return res.json(null);
  const queue = await queueOfDevice(o.device_id);
  const myPos = queue.findIndex((x) => x.id === o.id);
  const lostItem = await one('SELECT id, status, keeper FROM lost_items WHERE order_id=$1', [o.id]);
  const authRow = await one(`SELECT id, status FROM pickup_auths WHERE order_id=$1 AND status='authorized'`, [o.id]);
  res.json({ ...o, queue_position: myPos >= 0 ? myPos + 1 : null, queue_count: queue.length, lost_item: lostItem, pickup_auth: authRow });
}));

router.post('/orders/:id/pay', auth, ah(async (req, res) => {
  const { method = 'wechat' } = req.body || {};
  const o = await one('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (!o || o.user_id !== req.user.id) return bad(res, '订单不存在', 404);
  if (o.status !== 'booked') return bad(res, '订单状态不可支付');
  let amount = o.amount_cents;
  let freeUsed = false;
  const me = await one('SELECT * FROM users WHERE id=$1', [req.user.id]);
  if (me.free_washes > 0 && o.mode_name?.includes('标准洗')) {
    amount = 0; freeUsed = true;
    await q('UPDATE users SET free_washes=free_washes-1 WHERE id=$1', [me.id]);
  }
  await tx(async (c) => {
    await c.query(`UPDATE orders SET pay_status='paid', pay_method=$1, status='paid', paid_at=now(), amount_cents=$2 WHERE id=$3`, [method, amount, o.id]);
    await c.query(`UPDATE devices SET status='queued' WHERE id=$1 AND status='idle'`, [o.device_id]);
  });
  const d = await one('SELECT code FROM devices WHERE id=$1', [o.device_id]);
  res.json({ ok: true, amount, free_used: freeUsed, message: freeUsed ? '已使用免费洗涤次数' : `支付成功 ¥${(amount / 100).toFixed(2)}`, device_code: d.code });
}));

router.post('/orders/:id/start', auth, ah(async (req, res) => {
  const o = await one('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (!o || o.user_id !== req.user.id) return bad(res, '订单不存在', 404);
  if (o.status !== 'paid') return bad(res, '订单未支付或已启动');
  const d = await one('SELECT d.*, s.rules FROM devices d JOIN sites s ON s.id=d.site_id WHERE d.id=$1', [o.device_id]);
  if (!['idle', 'queued'].includes(d.status)) return bad(res, '设备占用中，请等待前一位用户取衣');
  const queue = await queueOfDevice(d.id);
  if (queue.length && queue[0].id !== o.id) return bad(res, `你前面还有 ${queue.findIndex((x) => x.id === o.id)} 人排队`);
  if (inNightSilent(d.rules) && !d.rules.allowNightStart && !d.silent) {
    return bad(res, `夜间静音时段（${d.rules.nightSilent.start}~${d.rules.nightSilent.end}）仅静音机型可启动`, 403);
  }
  await tx(async (c) => {
    await c.query(`UPDATE orders SET status='running', started_at=now(), ends_at=now()+($1 || ' minutes')::interval WHERE id=$2`, [String(o.duration_min), o.id]);
    await c.query(`UPDATE devices SET status='running' WHERE id=$1`, [d.id]);
    if (d.type === 'washer') {
      await c.query(`UPDATE devices SET detergent_level=GREATEST(0, detergent_level-10) WHERE id=$1`, [d.id]);
    }
  });
  const after = await one('SELECT detergent_level FROM devices WHERE id=$1', [d.id]);
  if (d.type === 'washer' && after.detergent_level < 20) {
    await tx(async (c) => {
      const exist = await c.query(`SELECT id FROM tickets WHERE device_id=$1 AND type='detergent_low' AND status IN ('open','assigned','processing')`, [d.id]);
      if (!exist.rows[0]) {
        await createTicket(c, { type: 'detergent_low', deviceId: d.id, siteId: d.site_id, title: `${d.code} 洗衣液不足`, description: `设备洗衣液余量 ${after.detergent_level}%，请及时补充。`, assignedRole: 'cleaner' });
      }
    });
  }
  await notify(o.user_id, 'start', '设备已启动', `设备 ${d.code}「${o.mode_name}」已启动，预计 ${o.duration_min} 分钟后结束，结束前 5 分钟将提醒你。`);
  res.json({ ok: true, ends_in_min: o.duration_min });
}));

router.post('/orders/:id/pickup', auth, ah(async (req, res) => {
  const o = await one('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (!o || o.user_id !== req.user.id) return bad(res, '订单不存在', 404);
  if (o.status !== 'finished') return bad(res, '订单尚未完成，暂不能取衣');
  await tx(async (c) => {
    await c.query(`UPDATE orders SET status='closed', picked_up_at=now(), closed_at=now() WHERE id=$1`, [o.id]);
    await adjustCredit(c, o.user_id, o.overdue ? 0 : 1, o.overdue ? '超时订单已取回' : '按时取衣，信用+1', 'order', o.id);
    await notifyNextInQueue(c, o.device_id);
  });
  res.json({ ok: true, message: '取衣完成，感谢使用' });
}));

router.post('/orders/:id/cancel', auth, ah(async (req, res) => {
  const o = await one('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (!o || o.user_id !== req.user.id) return bad(res, '订单不存在', 404);
  if (!['booked', 'paid'].includes(o.status)) return bad(res, '当前状态不可取消');
  await tx(async (c) => {
    if (o.status === 'paid') {
      await c.query(`INSERT INTO refunds(order_id, user_id, amount_cents, reason, status, processed_at) VALUES($1,$2,$3,'用户取消自动退款','paid', now())`, [o.id, o.user_id, o.amount_cents]);
      await c.query(`UPDATE orders SET status='cancelled', pay_status='refunded', closed_at=now() WHERE id=$1`, [o.id]);
      // 已支付订单占着队列槽位：释放并重算设备队列、通知下一位
      await notifyNextInQueue(c, o.device_id);
    } else {
      // 未支付预约不占队列，直接关闭即可
      await c.query(`UPDATE orders SET status='cancelled', closed_at=now() WHERE id=$1`, [o.id]);
    }
  });
  res.json({ ok: true, message: o.status === 'paid' ? '已取消并原路退款' : '预约已取消' });
}));

/** 保洁代取授权 */
router.post('/orders/:id/authorize-pickup', auth, ah(async (req, res) => {
  const o = await one('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (!o || o.user_id !== req.user.id) return bad(res, '订单不存在', 404);
  if (o.status !== 'finished') return bad(res, '仅完成待取的订单可授权代取');
  const exist = await one(`SELECT id FROM pickup_auths WHERE order_id=$1 AND status='authorized'`, [o.id]);
  if (exist) return res.json({ ok: true, message: '已授权，保洁将代取并暂存' });
  await q(`INSERT INTO pickup_auths(order_id, user_id) VALUES($1,$2)`, [o.id, o.user_id]);
  const cleaners = await many(`SELECT id FROM users WHERE role='cleaner'`);
  for (const c of cleaners) await notify(c.id, 'auth', '代取授权', `订单 ${o.order_no} 用户授权保洁代取衣物，请前往处理。`);
  res.json({ ok: true, message: '已授权保洁代取，衣物将存入遗留物保管柜' });
}));

/** 问题上报（围绕同一设备订单的多角色协同入口） */
const REPORT_TYPES = {
  mid_stop: { label: '设备中途停机', role: 'maintenance', priority: 'high' },
  dryer_not_dry: { label: '烘干不干', role: 'maintenance', priority: 'normal' },
  detergent_low: { label: '洗衣液不足', role: 'cleaner', priority: 'normal' },
  wrong_pickup: { label: '衣物错拿申诉', role: 'service', priority: 'high' },
  door_stuck: { label: '门锁打不开', role: 'maintenance', priority: 'high' },
  refund_request: { label: '退款申请', role: 'service', priority: 'normal' },
  timeout_no_pickup: { label: '超时未取', role: 'cleaner', priority: 'normal' },
  noise: { label: '噪声投诉', role: 'property', priority: 'normal' },
  dispute: { label: '物业纠纷', role: 'property', priority: 'high' },
  device_fault: { label: '设备故障', role: 'maintenance', priority: 'high' },
  other: { label: '其他问题', role: 'service', priority: 'normal' },
};

router.post('/orders/:id/report', auth, ah(async (req, res) => {
  const { type, description = '' } = req.body || {};
  const cfg = REPORT_TYPES[type];
  if (!cfg) return bad(res, '未知问题类型');
  const o = await one('SELECT o.*, d.code AS device_code FROM orders o JOIN devices d ON d.id=o.device_id WHERE o.id=$1', [req.params.id]);
  if (!o) return bad(res, '订单不存在', 404);
  if (o.user_id !== req.user.id && !['service', 'property'].includes(req.user.role)) return bad(res, '只能对自己的订单上报', 403);
  const t = await tx(async (c) => {
    const ticket = await createTicket(c, {
      type, orderId: o.id, deviceId: o.device_id, siteId: o.site_id,
      title: `${cfg.label} · ${o.device_code} · ${o.order_no}`,
      description, priority: cfg.priority, raisedBy: req.user.id, assignedRole: cfg.role,
    });
    await ticketEvent(c, ticket.id, req.user, 'report', `${req.user.name} 上报：${cfg.label}${description ? '——' + description : ''}`);
    if (type === 'refund_request') {
      await c.query(`INSERT INTO refunds(order_id, ticket_id, user_id, amount_cents, reason) VALUES($1,$2,$3,$4,$5)`,
        [o.id, ticket.id, o.user_id, o.amount_cents, description || cfg.label]);
    }
    return ticket;
  });
  res.json({ ok: true, ticket: t });
}));

/** 无订单的设备问题上报（如看到设备故障、噪声） */
router.post('/tickets', auth, ah(async (req, res) => {
  const { type, device_id, site_id, description = '' } = req.body || {};
  const cfg = REPORT_TYPES[type];
  if (!cfg) return bad(res, '未知问题类型');
  let title = cfg.label;
  if (device_id) {
    const d = await one('SELECT code FROM devices WHERE id=$1', [device_id]);
    if (d) title = `${cfg.label} · ${d.code}`;
  }
  const t = await tx(async (c) => {
    const ticket = await createTicket(c, {
      type, deviceId: device_id || null, siteId: site_id || null, title,
      description, priority: cfg.priority, raisedBy: req.user.id, assignedRole: cfg.role,
    });
    await ticketEvent(c, ticket.id, req.user, 'report', `${req.user.name} 上报：${cfg.label}`);
    return ticket;
  });
  res.json({ ok: true, ticket: t });
}));

/* ================= 工单中心 ================= */
router.get('/tickets', auth, ah(async (req, res) => {
  const { status } = req.query;
  const params = [];
  let where = '1=1';
  if (req.user.role === 'resident') { where = 't.raised_by=$1'; params.push(req.user.id); }
  else if (req.user.role === 'cleaner') { where = `(t.assigned_role='cleaner' OR t.assigned_to=$1)`; params.push(req.user.id); }
  else if (req.user.role === 'maintenance') { where = `(t.assigned_role='maintenance' OR t.assigned_to=$1)`; params.push(req.user.id); }
  if (status && status !== 'all') { params.push(status); where += ` AND t.status=$${params.length}`; }
  const rows = await many(
    `SELECT t.*, u.name AS raised_by_name, a.name AS assigned_to_name, d.code AS device_code, o.order_no, s.name AS site_name
     FROM tickets t
     LEFT JOIN users u ON u.id=t.raised_by LEFT JOIN users a ON a.id=t.assigned_to
     LEFT JOIN devices d ON d.id=t.device_id LEFT JOIN orders o ON o.id=t.order_id LEFT JOIN sites s ON s.id=t.site_id
     WHERE ${where} ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'assigned' THEN 1 WHEN 'processing' THEN 2 ELSE 3 END, t.priority='high' DESC, t.id DESC LIMIT 100`,
    params);
  res.json(rows);
}));

router.get('/tickets/:id', auth, ah(async (req, res) => {
  const t = await one(
    `SELECT t.*, u.name AS raised_by_name, a.name AS assigned_to_name, d.code AS device_code, o.order_no, o.status AS order_status, s.name AS site_name
     FROM tickets t LEFT JOIN users u ON u.id=t.raised_by LEFT JOIN users a ON a.id=t.assigned_to
     LEFT JOIN devices d ON d.id=t.device_id LEFT JOIN orders o ON o.id=t.order_id LEFT JOIN sites s ON s.id=t.site_id
     WHERE t.id=$1`, [req.params.id]);
  if (!t) return bad(res, '工单不存在', 404);
  if (req.user.role === 'resident' && t.raised_by !== req.user.id) return bad(res, '无权限查看该工单', 403);
  const events = await many('SELECT * FROM ticket_events WHERE ticket_id=$1 ORDER BY id', [t.id]);
  const refund = await one('SELECT * FROM refunds WHERE ticket_id=$1', [t.id]);
  res.json({ ...t, events, refund });
}));

router.post('/tickets/:id/assign', auth, requireRole('service', 'property'), ah(async (req, res) => {
  const { user_id } = req.body || {};
  const target = await one('SELECT * FROM users WHERE id=$1', [user_id]);
  if (!target) return bad(res, '处理人不存在');
  await tx(async (c) => {
    await c.query(`UPDATE tickets SET assigned_to=$1, assigned_role=$2, status=CASE WHEN status='open' THEN 'assigned' ELSE status END, updated_at=now() WHERE id=$3`,
      [target.id, target.role, req.params.id]);
    await ticketEvent(c, req.params.id, req.user, 'assign', `指派给 ${target.name}（${roleLabel(target.role)}）`);
  });
  await notify(target.id, 'ticket', '新工单指派', `工单 #${req.params.id} 已指派给你处理。`);
  res.json({ ok: true });
}));

router.post('/tickets/:id/claim', auth, requireRole('service', 'cleaner', 'maintenance', 'property'), ah(async (req, res) => {
  await tx(async (c) => {
    await c.query(`UPDATE tickets SET assigned_to=$1, status=CASE WHEN status IN ('open','assigned') THEN 'processing' ELSE status END, updated_at=now() WHERE id=$2`, [req.user.id, req.params.id]);
    await ticketEvent(c, req.params.id, req.user, 'claim', `${req.user.name} 开始处理`);
  });
  res.json({ ok: true });
}));

router.post('/tickets/:id/note', auth, ah(async (req, res) => {
  const { note } = req.body || {};
  if (!note) return bad(res, '内容不能为空');
  await tx(async (c) => {
    await c.query('UPDATE tickets SET updated_at=now() WHERE id=$1', [req.params.id]);
    await ticketEvent(c, req.params.id, req.user, 'note', note);
  });
  res.json({ ok: true });
}));

router.post('/tickets/:id/resolve', auth, requireRole('service', 'cleaner', 'maintenance', 'property'), ah(async (req, res) => {
  const { resolution = '' } = req.body || {};
  const t = await one('SELECT * FROM tickets WHERE id=$1', [req.params.id]);
  if (!t) return bad(res, '工单不存在', 404);
  await tx(async (c) => {
    await c.query(`UPDATE tickets SET status='resolved', resolution=$1, updated_at=now() WHERE id=$2`, [resolution, t.id]);
    await ticketEvent(c, t.id, req.user, 'resolve', resolution || '已解决');
    // 联动：洗衣液不足 → 若保洁已补液则恢复
    if (t.type === 'detergent_low' && t.device_id) {
      await c.query('UPDATE devices SET detergent_level=100 WHERE id=$1', [t.device_id]);
      const dev = await c.query('SELECT site_id, code FROM devices WHERE id=$1', [t.device_id]);
      await c.query(`INSERT INTO restocks(site_id, item, quantity, operator_id, note) VALUES($1,'洗衣液',1,$2,$3)`,
        [dev.rows[0].site_id, req.user.id, `工单补液：${dev.rows[0].code}`]);
    }
    // 联动：设备故障/中途停机修复 → 设备恢复空闲
    if (['device_fault', 'mid_stop', 'dryer_not_dry', 'door_stuck'].includes(t.type) && t.device_id) {
      const active = await c.query(`SELECT id FROM orders WHERE device_id=$1 AND status IN ('running','finished')`, [t.device_id]);
      if (!active.rows[0]) await c.query(`UPDATE devices SET status='idle' WHERE id=$1 AND status IN ('fault','maintenance')`, [t.device_id]);
    }
  });
  if (t.raised_by) await notify(t.raised_by, 'ticket', '工单已解决', `你上报的「${t.title}」已解决：${resolution || '已处理'}`);
  res.json({ ok: true });
}));

router.post('/tickets/:id/close', auth, ah(async (req, res) => {
  const t = await one('SELECT * FROM tickets WHERE id=$1', [req.params.id]);
  if (!t) return bad(res, '工单不存在', 404);
  const isOwner = t.raised_by === req.user.id;
  if (!isOwner && !['service', 'property'].includes(req.user.role)) return bad(res, '无权限关闭', 403);
  await tx(async (c) => {
    await c.query(`UPDATE tickets SET status='closed', closed_at=now(), updated_at=now() WHERE id=$1`, [t.id]);
    await ticketEvent(c, t.id, req.user, 'close', '工单关闭归档');
  });
  res.json({ ok: true });
}));

/* ================= 退款 ================= */
router.get('/refunds', auth, ah(async (req, res) => {
  const params = [];
  let where = '1=1';
  if (req.user.role === 'resident') { where = 'r.user_id=$1'; params.push(req.user.id); }
  const rows = await many(
    `SELECT r.*, o.order_no, o.mode_name, u.name AS user_name, p.name AS processor_name, d.code AS device_code
     FROM refunds r JOIN orders o ON o.id=r.order_id JOIN users u ON u.id=r.user_id
     LEFT JOIN users p ON p.id=r.processed_by JOIN devices d ON d.id=o.device_id
     WHERE ${where} ORDER BY r.id DESC LIMIT 100`, params);
  res.json(rows);
}));

/**
 * 退款审批：按订单所处阶段结算，工单/退款/订单/设备/队列/通知/档案使用同一处置结论。
 * - booked/paid（未启动）全额退款：同事务关闭订单、结算支付、释放/重排设备队列并通知下一位；
 * - booked/paid 部分退款：订单继续有效，仅标记 partial_refunded；
 * - running/finished（已启动/已完成）：保留实际服务状态，仅结算支付标记，不释放在用设备；
 * - 幂等：订单行锁 + 原子认领退款单，撤销/重复审批不产生二次退款、重复通知或队列跳位。
 */
router.post('/refunds/:id/approve', auth, requireRole('service', 'property'), ah(async (req, res) => {
  const r = await one('SELECT * FROM refunds WHERE id=$1', [req.params.id]);
  if (!r) return bad(res, '退款单不存在', 404);
  const amountText = `¥${(r.amount_cents / 100).toFixed(2)}`;
  const result = await tx(async (c) => {
    // 锁定订单行：与并发审批/用户取消串行化，保证同一订单只有一个处置结论
    const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [r.order_id])).rows[0];
    if (!o) return { error: '关联订单不存在', code: 404 };
    if (o.pay_status === 'unpaid') return { error: '订单未支付，无款可退，请驳回该申请' };
    if (o.pay_status === 'refunded') return { error: '该订单已全额退款，请勿重复审批' };
    // 原子认领：仅待审核的退款单可被处理，重复/并发审批落空，不会二次退款
    const claim = await c.query(
      `UPDATE refunds SET status='paid', processed_by=$1, processed_at=now() WHERE id=$2 AND status='requested' RETURNING id`,
      [req.user.id, r.id]);
    if (!claim.rows[0]) return { error: '该退款已处理' };

    const full = r.amount_cents >= o.amount_cents;
    const notStarted = ['booked', 'paid'].includes(o.status);
    let path;
    if (notStarted && full) {
      // 未启动全额退款：关闭订单、结算支付、释放/重排设备队列并通知下一位
      await c.query(`UPDATE orders SET pay_status='refunded', status='cancelled', closed_at=now() WHERE id=$1`, [o.id]);
      await notifyNextInQueue(c, o.device_id);
      path = 'closed';
    } else if (notStarted) {
      // 未启动部分退款：订单继续有效，可正常排队启动
      await c.query(`UPDATE orders SET pay_status='partial_refunded' WHERE id=$1`, [o.id]);
      path = 'partial';
    } else {
      // 已启动/已完成/已终结：保留实际服务状态，仅结算支付标记，不释放在用设备
      await c.query(`UPDATE orders SET pay_status=$1 WHERE id=$2`, [full ? 'refunded' : 'partial_refunded', o.id]);
      path = 'settled';
    }
    if (r.ticket_id) {
      const resolution = {
        closed: `退款 ${amountText} 已原路退回；订单已关闭，设备队列已释放/重排`,
        partial: `部分退款 ${amountText} 已原路退回；订单继续有效`,
        settled: `退款 ${amountText} 已原路退回；订单服务状态不变`,
      }[path];
      await c.query(`UPDATE tickets SET status='resolved', resolution=$1, updated_at=now() WHERE id=$2`, [resolution, r.ticket_id]);
      await ticketEvent(c, r.ticket_id, req.user, 'refund', resolution);
    }
    return { path };
  });
  if (result.error) return bad(res, result.error, result.code || 400);
  const message = {
    closed: `退款 ${amountText} 已原路退回，订单已关闭，设备队列已释放`,
    partial: `部分退款 ${amountText} 已原路退回，订单继续有效`,
    settled: `退款 ${amountText} 已原路退回，当前订单服务不受影响`,
  }[result.path];
  await notify(r.user_id, 'refund', result.path === 'partial' ? '部分退款到账' : '退款到账', `订单退款处理完成：${message}。`);
  res.json({ ok: true, path: result.path, message });
}));

router.post('/refunds/:id/reject', auth, requireRole('service', 'property'), ah(async (req, res) => {
  const { note = '' } = req.body || {};
  const r = await one('SELECT * FROM refunds WHERE id=$1', [req.params.id]);
  if (!r) return bad(res, '退款单不存在', 404);
  const done = await tx(async (c) => {
    // 原子认领：重复/并发驳回只生效一次，避免重复通知
    const claim = await c.query(
      `UPDATE refunds SET status='rejected', processed_by=$1, processed_at=now() WHERE id=$2 AND status='requested' RETURNING id`,
      [req.user.id, r.id]);
    if (!claim.rows[0]) return false;
    if (r.ticket_id) await ticketEvent(c, r.ticket_id, req.user, 'reject', `退款驳回：${note}`);
    return true;
  });
  if (!done) return bad(res, '该退款已处理');
  await notify(r.user_id, 'refund', '退款未通过', `你的退款申请未通过${note ? '：' + note : ''}，如有异议可联系物业。`);
  res.json({ ok: true });
}));

/* ================= 保洁 ================= */
router.post('/inspections', auth, requireRole('cleaner', 'property'), ah(async (req, res) => {
  const { site_id, floor_status, filter_status, detergent_status, odor_status, leftover_status, camera_status, note = '' } = req.body || {};
  if (!site_id || !floor_status || !filter_status || !detergent_status || !odor_status || !leftover_status || !camera_status) {
    return bad(res, '请完整填写巡检项（地面/滤网/洗衣液/异味/遗留衣物/摄像头）');
  }
  const r = await q(
    `INSERT INTO inspections(site_id, cleaner_id, floor_status, filter_status, detergent_status, odor_status, leftover_status, camera_status, note)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [site_id, req.user.id, floor_status, filter_status, detergent_status, odor_status, leftover_status, camera_status, note]);
  await q('UPDATE devices SET last_cleaned_at=now() WHERE site_id=$1', [site_id]);
  // 巡检异常 → 自动生成对应工单
  await tx(async (c) => {
    if (detergent_status === '不足') {
      const devs = await c.query(`SELECT id, code FROM devices WHERE site_id=$1 AND detergent_level<30`, [site_id]);
      for (const d of devs.rows) {
        const exist = await c.query(`SELECT id FROM tickets WHERE device_id=$1 AND type='detergent_low' AND status IN ('open','assigned','processing')`, [d.id]);
        if (!exist.rows[0]) await createTicket(c, { type: 'detergent_low', deviceId: d.id, siteId: site_id, title: `${d.code} 洗衣液不足`, assignedRole: 'cleaner' });
      }
    }
    if (camera_status === '异常') {
      await createTicket(c, { type: 'device_fault', siteId: site_id, title: '摄像头异常待检修', description: `巡检发现摄像头异常：${note}`, assignedRole: 'maintenance', priority: 'high' });
    }
  });
  res.json(r.rows[0]);
}));

router.get('/inspections', auth, ah(async (req, res) => {
  const { site_id } = req.query;
  const params = [];
  let where = '1=1';
  if (site_id) { where = 'i.site_id=$1'; params.push(site_id); }
  const rows = await many(
    `SELECT i.*, u.name AS cleaner_name, s.name AS site_name FROM inspections i
     JOIN users u ON u.id=i.cleaner_id JOIN sites s ON s.id=i.site_id
     WHERE ${where} ORDER BY i.id DESC LIMIT 50`, params);
  res.json(rows);
}));

router.post('/restocks', auth, requireRole('cleaner', 'property'), ah(async (req, res) => {
  const { site_id, item, quantity, device_id, note = '' } = req.body || {};
  if (!site_id || !item || !quantity) return bad(res, '请填写补货物品与数量');
  const r = await q(`INSERT INTO restocks(site_id, item, quantity, operator_id, note) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [site_id, item, quantity, req.user.id, note]);
  if (device_id && item.includes('洗衣液')) {
    await q('UPDATE devices SET detergent_level=100 WHERE id=$1', [device_id]);
  }
  res.json(r.rows[0]);
}));

router.get('/restocks', auth, ah(async (req, res) => {
  const rows = await many(
    `SELECT r.*, u.name AS operator_name, s.name AS site_name FROM restocks r
     LEFT JOIN users u ON u.id=r.operator_id JOIN sites s ON s.id=r.site_id ORDER BY r.id DESC LIMIT 50`);
  res.json(rows);
}));

/** 保洁任务台：待补液设备 + 待取订单（含代取资格评估）+ 代取授权 + 保管中封袋 */
router.get('/cleaner/tasks', auth, requireRole('cleaner', 'property'), ah(async (req, res) => {
  const lowDevices = await many(
    `SELECT d.id, d.code, d.detergent_level, s.name AS site_name FROM devices d JOIN sites s ON s.id=d.site_id
     WHERE d.detergent_level < 30 AND d.status NOT IN ('offline') ORDER BY d.detergent_level`);
  // 全部待取衣订单：页面按「倒计时 / 短信提醒 / 排队人数」评估是否允许代取
  const pickupOrders = await many(
    `SELECT o.id, o.order_no, o.mode_name, o.pickup_deadline, o.overdue, o.sms_count, o.user_id,
            u.name AS user_name, d.id AS device_id, d.code AS device_code, s.name AS site_name, s.rules
     FROM orders o JOIN users u ON u.id=o.user_id JOIN devices d ON d.id=o.device_id JOIN sites s ON s.id=o.site_id
     WHERE o.status='finished' ORDER BY o.pickup_deadline`);
  for (const o of pickupOrders) {
    const qc = await one(`SELECT count(*)::int AS c FROM orders WHERE device_id=$1 AND status='paid'`, [o.device_id]);
    o.queue_count = qc?.c ?? 0;
    o.eligibility = proxyEligibility(o, o.queue_count, o.rules || {});
    delete o.rules;
  }
  const auths = await many(
    `SELECT pa.id, pa.order_id, pa.created_at, o.order_no, u.name AS user_name, d.code AS device_code, s.name AS site_name
     FROM pickup_auths pa JOIN orders o ON o.id=pa.order_id JOIN users u ON u.id=pa.user_id
     JOIN devices d ON d.id=o.device_id JOIN sites s ON s.id=o.site_id
     WHERE pa.status='authorized' AND o.status='finished' ORDER BY pa.id`);
  const proxyStored = await many(
    `SELECT p.id, p.bag_no, p.cabinet_no, p.keep_until, p.created_at, o.order_no, u.name AS user_name, d.code AS device_code, s.name AS site_name
     FROM proxy_pickups p JOIN orders o ON o.id=p.order_id JOIN users u ON u.id=p.user_id
     JOIN devices d ON d.id=p.device_id JOIN sites s ON s.id=p.site_id
     WHERE p.status='stored' ORDER BY p.keep_until`);
  res.json({ lowDevices, pickupOrders, auths, proxyStored });
}));

/** 建议封袋编号（保洁代取弹窗预填） */
router.get('/proxy-pickups/next-bag-no', auth, requireRole('cleaner', 'property'), ah(async (req, res) => {
  res.json({ bag_no: genNo('BAG') });
}));

/**
 * 保洁代取（超时占机处理）：拍照留档 + 封袋编号 + 存放柜编号 + 保洁现场确认。
 * - 超时强制代取：需通过资格评估（倒计时结束 + 已短信提醒 + 有人排队或超时达限）；
 * - 用户授权代取（auth_id）：无需超时条件，授权即视为用户同意；
 * 同一事务：订单终结为 expired、生成代取记录（用户确认任务）、释放设备并重排队列、关闭超时工单。
 */
router.post('/orders/:id/proxy-collect', auth, requireRole('cleaner', 'property'), ah(async (req, res) => {
  const { photo_note = '', bag_no = '', cabinet_no = '', confirmed = false, auth_id = null } = req.body || {};
  if (!String(photo_note).trim()) return bad(res, '请填写拍照留档说明（现场照片记录）');
  if (!String(bag_no).trim()) return bad(res, '请填写封袋编号');
  if (!String(cabinet_no).trim()) return bad(res, '请填写存放柜编号');
  if (!confirmed) return bad(res, '请勾选保洁现场确认后再提交');
  const o = await one(
    `SELECT o.*, d.code AS device_code, s.rules FROM orders o
     JOIN devices d ON d.id=o.device_id JOIN sites s ON s.id=o.site_id WHERE o.id=$1`, [req.params.id]);
  if (!o) return bad(res, '订单不存在', 404);

  let result;
  try {
    result = await tx(async (c) => {
      // 原子认领：仅「待取衣」订单可被代取，并发/重复提交落空（失败抛错回滚，不会误提交）
      const claim = await c.query(`UPDATE orders SET status='expired', closed_at=now() WHERE id=$1 AND status='finished' RETURNING id`, [o.id]);
      if (!claim.rows[0]) throw new BizError('订单不在待取状态或已被处理');

      if (auth_id) {
        // 用户授权代取：核销授权（原子），无需超时资格
        const pa = await c.query(
          `UPDATE pickup_auths SET status='used', cleaner_id=$1, used_at=now() WHERE id=$2 AND status='authorized' AND order_id=$3 RETURNING id`,
          [req.user.id, auth_id, o.id]);
        if (!pa.rows[0]) throw new BizError('代取授权不存在或已使用');
      } else {
        // 超时强制代取：按倒计时 / 短信提醒 / 排队人数评估
        const qc = await c.query(`SELECT count(*)::int AS c FROM orders WHERE device_id=$1 AND status='paid'`, [o.device_id]);
        const el = proxyEligibility(o, qc.rows[0].c, o.rules || {});
        if (!el.canProxy) throw new BizError(`暂不允许代取：${el.reason}`);
      }

      const keepHours = (o.rules && o.rules.proxyKeepHours) ?? 48;
      const confirmCode = 'PX' + String(Math.floor(100000 + Math.random() * 900000));
      let pp;
      try {
        pp = (await c.query(
          `INSERT INTO proxy_pickups(order_id, user_id, cleaner_id, site_id, device_id, photo_note, bag_no, cabinet_no, confirm_code, keep_until)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9, now()+($10 || ' hours')::interval) RETURNING *`,
          [o.id, o.user_id, req.user.id, o.site_id, o.device_id, String(photo_note).trim(),
           String(bag_no).trim().toUpperCase(), String(cabinet_no).trim(), confirmCode, String(keepHours)]
        )).rows[0];
      } catch (e) {
        if (e.code === '23505') throw new BizError('封袋编号已存在，请更换编号');
        throw e;
      }

      // 释放设备并重排队列（设备仍被占用时不动）
      await notifyNextInQueue(c, o.device_id);
      // 关闭关联的超时工单
      const t = await c.query(`SELECT id FROM tickets WHERE order_id=$1 AND type='timeout_no_pickup' AND status IN ('open','assigned','processing')`, [o.id]);
      if (t.rows[0]) {
        await c.query(`UPDATE tickets SET status='resolved', resolution=$1, updated_at=now() WHERE id=$2`,
          [`保洁代取：拍照留档、封袋 ${pp.bag_no}、存入 ${pp.cabinet_no} 柜`, t.rows[0].id]);
        await ticketEvent(c, t.rows[0].id, req.user, 'resolve', `保洁代取封袋入柜，设备已释放`);
      }
      return { pp, keepHours };
    });
  } catch (e) {
    if (e instanceof BizError) return bad(res, e.message, e.code);
    throw e;
  }
  const { pp, keepHours } = result;
  await notify(o.user_id, 'proxy', '衣物已由保洁代取封袋',
    `您在设备 ${o.device_code} 的衣物${auth_id ? '按您授权' : '超时未取'}，保洁已拍照留档并封袋代收。封袋编号 ${pp.bag_no}，存放柜 ${pp.cabinet_no}，保管 ${keepHours} 小时。取回时请核对封袋编号并到柜扫码确认；逾期将移交物业按遗留物处理。`);
  res.json({ ok: true, proxy: pp, message: `已代取封袋 ${pp.bag_no} 入柜 ${pp.cabinet_no}，设备已释放` });
}));

/* ================= 代取确认任务（用户取回） ================= */
/** 居民：我的代取任务（含历史） */
router.get('/proxy-pickups/mine', auth, ah(async (req, res) => {
  const rows = await many(
    `SELECT p.id, p.order_id, p.bag_no, p.cabinet_no, p.photo_note, p.status, p.keep_until, p.created_at, p.returned_at, p.escalated_at,
            o.order_no, o.mode_name, d.code AS device_code, s.name AS site_name, cl.name AS cleaner_name
     FROM proxy_pickups p JOIN orders o ON o.id=p.order_id JOIN devices d ON d.id=p.device_id
     JOIN sites s ON s.id=p.site_id JOIN users cl ON cl.id=p.cleaner_id
     WHERE p.user_id=$1 ORDER BY p.id DESC LIMIT 30`, [req.user.id]);
  res.json(rows);
}));

/** 模拟用户到柜扫码：返回柜门二维码内容（真实场景为现场扫码获得） */
router.get('/proxy-pickups/:id/scan-code', auth, ah(async (req, res) => {
  const pp = await one('SELECT * FROM proxy_pickups WHERE id=$1', [req.params.id]);
  if (!pp || pp.user_id !== req.user.id) return bad(res, '代取任务不存在', 404);
  if (pp.status !== 'stored') return bad(res, '当前状态不可扫码取回');
  res.json({ payload: `LAUNDRY-PICKUP://cabinet/${pp.cabinet_no}/${pp.confirm_code}`, cabinet_no: pp.cabinet_no });
}));

/** 用户取回确认：核对封袋编号 + 扫码确认（原子状态推进，防重复取回） */
router.post('/proxy-pickups/:id/confirm', auth, requireRole('resident'), ah(async (req, res) => {
  const { bag_no = '', scan_payload = '' } = req.body || {};
  if (!String(bag_no).trim()) return bad(res, '请输入封袋上的封袋编号');
  if (!String(scan_payload).trim()) return bad(res, '请扫描存放柜上的二维码');
  const pp = await one('SELECT * FROM proxy_pickups WHERE id=$1', [req.params.id]);
  if (!pp || pp.user_id !== req.user.id) return bad(res, '代取任务不存在', 404);
  if (pp.status === 'returned') return bad(res, '该衣物已取回，请勿重复操作');
  if (pp.status !== 'stored') return bad(res, '该衣物已逾期转入遗留物流程，请在「我的-遗留物」申请认领');
  if (pp.bag_no !== String(bag_no).trim().toUpperCase()) return bad(res, '封袋编号不一致，请核对封袋上的编号');
  if (!String(scan_payload).includes(pp.confirm_code)) return bad(res, '扫码信息无效，请扫描存放柜上的二维码');
  const done = await tx(async (c) => {
    const r = await c.query(`UPDATE proxy_pickups SET status='returned', returned_at=now() WHERE id=$1 AND status='stored' RETURNING id`, [pp.id]);
    if (!r.rows[0]) return false;
    await adjustCredit(c, pp.user_id, 1, `代取衣物核对取回（封袋 ${pp.bag_no}），信用+1`, 'proxy_pickup', pp.id);
    return true;
  });
  if (!done) return bad(res, '该衣物已处理，请刷新后重试');
  await notify(pp.cleaner_id, 'proxy', '用户已取回代取衣物', `封袋 ${pp.bag_no}（柜 ${pp.cabinet_no}）已由用户核对封袋编号并扫码取回。`);
  res.json({ ok: true, message: '核对成功，衣物已取回' });
}));

/** 保洁/物业/客服：代取记录列表 */
router.get('/proxy-pickups', auth, requireRole('cleaner', 'property', 'service'), ah(async (req, res) => {
  const rows = await many(
    `SELECT p.*, o.order_no, d.code AS device_code, s.name AS site_name, u.name AS user_name, cl.name AS cleaner_name
     FROM proxy_pickups p JOIN orders o ON o.id=p.order_id JOIN devices d ON d.id=p.device_id
     JOIN sites s ON s.id=p.site_id JOIN users u ON u.id=p.user_id JOIN users cl ON cl.id=p.cleaner_id
     ORDER BY p.id DESC LIMIT 100`);
  res.json(rows);
}));

/* ================= 遗留物 ================= */
router.get('/lost-items', auth, ah(async (req, res) => {
  const params = [];
  let where = '1=1';
  if (req.user.role === 'resident') { where = '(l.claimed_by=$1 OR o.user_id=$1 OR l.status=$2)'; params.push(req.user.id, 'stored'); }
  const rows = await many(
    `SELECT l.*, s.name AS site_name, d.code AS device_code, o.order_no, f.name AS found_by_name, cb.name AS claimed_by_name, ou.name AS owner_name
     FROM lost_items l JOIN sites s ON s.id=l.site_id LEFT JOIN devices d ON d.id=l.device_id
     LEFT JOIN orders o ON o.id=l.order_id LEFT JOIN users f ON f.id=l.found_by
     LEFT JOIN users cb ON cb.id=l.claimed_by LEFT JOIN users ou ON ou.id=o.user_id
     WHERE ${where} ORDER BY l.id DESC LIMIT 100`, params);
  res.json(rows);
}));

router.post('/lost-items/:id/claim', auth, ah(async (req, res) => {
  const item = await one('SELECT * FROM lost_items WHERE id=$1', [req.params.id]);
  if (!item || item.status !== 'stored') return bad(res, '物品不存在或已被处理');
  await q(`UPDATE lost_items SET status='claimed', claimed_by=$1, claimed_at=now() WHERE id=$2`, [req.user.id, item.id]);
  const cleaners = await many(`SELECT id FROM users WHERE role IN ('cleaner','service')`);
  for (const c of cleaners) await notify(c.id, 'lost', '遗留物认领申请', `${req.user.name} 申请认领「${item.description}」，请核实后交接。`);
  res.json({ ok: true, message: '认领申请已提交，保洁/客服核实后将与你交接' });
}));

router.post('/lost-items/:id/return', auth, requireRole('cleaner', 'service', 'property'), ah(async (req, res) => {
  const item = await one('SELECT * FROM lost_items WHERE id=$1', [req.params.id]);
  if (!item || !['stored', 'claimed'].includes(item.status)) return bad(res, '物品状态不可交接');
  await tx(async (c) => {
    await c.query(`UPDATE lost_items SET status='returned' WHERE id=$1`, [item.id]);
    if (item.claimed_by) await adjustCredit(c, item.claimed_by, 1, '遗留物认领归还，信用恢复', 'lost_item', item.id);
  });
  if (item.claimed_by) await notify(item.claimed_by, 'lost', '遗留物已归还', `「${item.description}」已完成交接，感谢配合。`);
  res.json({ ok: true });
}));

router.post('/lost-items/:id/dispose', auth, requireRole('cleaner', 'property'), ah(async (req, res) => {
  await q(`UPDATE lost_items SET status='disposed' WHERE id=$1 AND status='stored'`, [req.params.id]);
  res.json({ ok: true });
}));

/* ================= 维修 ================= */
router.get('/maintenance/board', auth, requireRole('maintenance', 'property'), ah(async (req, res) => {
  const devices = await many(
    `SELECT d.*, s.name AS site_name, z.name AS zone_name FROM devices d
     JOIN sites s ON s.id=d.site_id LEFT JOIN zones z ON z.id=d.zone_id
     WHERE d.status IN ('fault','maintenance','offline') ORDER BY d.status, d.code`);
  const repairs = await many(
    `SELECT r.*, d.code AS device_code, u.name AS technician_name FROM repairs r
     JOIN devices d ON d.id=r.device_id LEFT JOIN users u ON u.id=r.technician_id ORDER BY r.id DESC LIMIT 30`);
  res.json({ devices, repairs });
}));

router.put('/devices/:id/status', auth, requireRole('maintenance', 'property'), ah(async (req, res) => {
  const { status, note = '' } = req.body || {};
  const allowed = ['idle', 'fault', 'maintenance', 'offline'];
  if (!allowed.includes(status)) return bad(res, '非法状态');
  const d = await one('SELECT * FROM devices WHERE id=$1', [req.params.id]);
  if (!d) return bad(res, '设备不存在', 404);
  const active = await activeOrderOfDevice(d.id);
  if (active && ['fault', 'maintenance', 'offline'].includes(status)) {
    return bad(res, '设备有进行中的订单，请先处理订单（中途停机请走工单）');
  }
  await q('UPDATE devices SET status=$1 WHERE id=$2', [status, d.id]);
  if (['fault', 'maintenance'].includes(status)) {
    await tx(async (c) => {
      const exist = await c.query(`SELECT id FROM tickets WHERE device_id=$1 AND type='device_fault' AND status IN ('open','assigned','processing')`, [d.id]);
      if (!exist.rows[0]) {
        await createTicket(c, { type: 'device_fault', deviceId: d.id, siteId: d.site_id, title: `${d.code} 设备${status === 'fault' ? '故障' : '进入维修'}`, description: note, assignedRole: 'maintenance', priority: 'high' });
      }
    });
  }
  res.json({ ok: true });
}));

router.post('/devices/:id/unlock', auth, requireRole('maintenance', 'service', 'property'), ah(async (req, res) => {
  const d = await one('SELECT * FROM devices WHERE id=$1', [req.params.id]);
  if (!d) return bad(res, '设备不存在', 404);
  await tx(async (c) => {
    const t = await c.query(`SELECT id FROM tickets WHERE device_id=$1 AND type='door_stuck' AND status IN ('open','assigned','processing')`, [d.id]);
    if (t.rows[0]) {
      await c.query(`UPDATE tickets SET status='resolved', resolution='远程开锁成功', updated_at=now() WHERE id=$1`, [t.rows[0].id]);
      await ticketEvent(c, t.rows[0].id, req.user, 'unlock', '远程开锁成功，用户可取衣');
    }
  });
  res.json({ ok: true, message: `已向设备 ${d.code} 发送开锁指令` });
}));

router.post('/repairs', auth, requireRole('maintenance', 'property'), ah(async (req, res) => {
  const { device_id, ticket_id, description, cost_cents = 0 } = req.body || {};
  if (!device_id || !description) return bad(res, '请填写设备与维修内容');
  const r = await q(
    `INSERT INTO repairs(device_id, ticket_id, technician_id, description, cost_cents, status, done_at) VALUES($1,$2,$3,$4,$5,'done', now()) RETURNING *`,
    [device_id, ticket_id || null, req.user.id, description, Math.round(cost_cents)]);
  await q(`UPDATE devices SET status='idle' WHERE id=$1 AND status IN ('fault','maintenance')`, [device_id]);
  if (ticket_id) {
    await tx(async (c) => {
      await c.query(`UPDATE tickets SET status='resolved', resolution=$1, updated_at=now() WHERE id=$2 AND status NOT IN ('resolved','closed')`, [`维修完成：${description}`, ticket_id]);
      await ticketEvent(c, ticket_id, req.user, 'repair', `维修完成：${description}，费用 ¥${(cost_cents / 100).toFixed(2)}`);
    });
  }
  res.json(r.rows[0]);
}));

/* ================= 会员套餐 ================= */
router.get('/packages', auth, ah(async (req, res) => {
  res.json(await many('SELECT * FROM packages ORDER BY price_cents'));
}));

router.post('/packages/:id/buy', auth, requireRole('resident'), ah(async (req, res) => {
  const p = await one('SELECT * FROM packages WHERE id=$1', [req.params.id]);
  if (!p) return bad(res, '套餐不存在', 404);
  await q(
    `UPDATE users SET package_id=$1, package_expires_at=now()+($2 || ' days')::interval, free_washes=free_washes+$3 WHERE id=$4`,
    [p.id, String(p.duration_days), p.free_washes, req.user.id]);
  res.json({ ok: true, message: `已开通「${p.name}」，¥${(p.price_cents / 100).toFixed(2)}（模拟支付）` });
}));

/* ================= 通知 ================= */
router.get('/notifications/mine', auth, ah(async (req, res) => {
  const rows = await many('SELECT * FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 30', [req.user.id]);
  res.json(rows);
}));

router.post('/notifications/read-all', auth, ah(async (req, res) => {
  await q('UPDATE notifications SET read=true WHERE user_id=$1', [req.user.id]);
  res.json({ ok: true });
}));

/* ================= 物业：统计 / 建议 / 规则 / 档案 ================= */
router.get('/stats/overview', auth, requireRole('property', 'service'), ah(async (req, res) => {
  const siteId = req.query.site_id ? Number(req.query.site_id) : null;
  const p = siteId ? [siteId] : [];
  const w = siteId ? 'WHERE site_id=$1' : '';
  const deviceStats = await many(
    `SELECT d.id, d.code, d.type, d.status, d.capacity_kg,
       COALESCE(SUM(CASE WHEN o.status IN ('running','finished','picked','closed') AND o.started_at > now()-interval '30 days' THEN o.duration_min ELSE 0 END),0)::int AS used_min,
       COUNT(CASE WHEN o.started_at > now()-interval '30 days' AND o.status NOT IN ('cancelled') THEN 1 END)::int AS order_count
     FROM devices d LEFT JOIN orders o ON o.device_id=d.id
     ${siteId ? 'WHERE d.site_id=$1' : ''} GROUP BY d.id ORDER BY d.code`, p);
  const cap = 30 * 24 * 60;
  for (const d of deviceStats) d.utilization = Math.min(1, d.used_min / cap);
  const today = await one(
    `SELECT COUNT(*)::int AS orders, COALESCE(SUM(amount_cents),0)::int AS revenue FROM orders
     WHERE paid_at::date=now()::date AND pay_status IN ('paid','refunded','partial_refunded') ${siteId ? 'AND site_id=$1' : ''}`, p);
  const ticketsByType = await many(
    `SELECT type, COUNT(*)::int AS c FROM tickets WHERE created_at > now()-interval '30 days' ${siteId ? 'AND site_id=$1' : ''} GROUP BY type ORDER BY c DESC`, p);
  const openTickets = await one(`SELECT COUNT(*)::int AS c FROM tickets WHERE status IN ('open','assigned','processing') ${siteId ? 'AND site_id=$1' : ''}`, p);
  const avgWait = await one(
    `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (started_at-paid_at))/60),0)::int AS m FROM orders
     WHERE started_at IS NOT NULL AND started_at > now()-interval '30 days' ${siteId ? 'AND site_id=$1' : ''}`, p);
  const revenue30 = await one(
    `SELECT COALESCE(SUM(amount_cents),0)::int AS s FROM orders WHERE paid_at > now()-interval '30 days' AND pay_status IN ('paid','refunded','partial_refunded') ${siteId ? 'AND site_id=$1' : ''}`, p);
  res.json({ deviceStats, today, ticketsByType, openTickets: openTickets.c, avgWaitMin: avgWait.m, revenue30: revenue30.s });
}));

router.get('/stats/suggestions', auth, requireRole('property'), ah(async (req, res) => {
  const siteId = Number(req.query.site_id);
  if (!siteId) return bad(res, '缺少门店参数');
  const site = await one('SELECT * FROM sites WHERE id=$1', [siteId]);
  const util = await many(
    `SELECT d.type, COALESCE(SUM(CASE WHEN o.started_at > now()-interval '30 days' AND o.status NOT IN ('cancelled') THEN o.duration_min ELSE 0 END),0)::int AS used_min,
            COUNT(DISTINCT d.id)::int AS n
     FROM devices d LEFT JOIN orders o ON o.device_id=d.id WHERE d.site_id=$1 GROUP BY d.type`, [siteId]);
  const cap = 30 * 24 * 60;
  const complaints = await many(
    `SELECT type, COUNT(*)::int AS c FROM tickets WHERE site_id=$1 AND created_at > now()-interval '30 days' GROUP BY type`, [siteId]);
  const cmap = Object.fromEntries(complaints.map((x) => [x.type, x.c]));
  const suggestions = [];
  for (const u of util) {
    const rate = u.n ? u.used_min / (cap * u.n) : 0;
    const label = u.type === 'washer' ? '洗衣机' : '烘干机';
    if (rate > 0.5) suggestions.push({ level: 'high', title: `建议增加${label}`, detail: `${label}近 30 天利用率 ${(rate * 100).toFixed(0)}%，排队明显，建议新增 1~2 台或引导错峰。` });
    else if (rate < 0.1) suggestions.push({ level: 'low', title: `${label}利用率偏低`, detail: `${label}利用率仅 ${(rate * 100).toFixed(0)}%，建议错峰折扣或调整定价，暂缓扩容。` });
  }
  if ((cmap.device_fault || 0) + (cmap.dryer_not_dry || 0) >= 2) suggestions.push({ level: 'high', title: '设备故障频发', detail: `近 30 天故障/烘干不干工单 ${(cmap.device_fault || 0) + (cmap.dryer_not_dry || 0)} 起，建议检修或更换老旧设备。` });
  if ((cmap.noise || 0) >= 1) suggestions.push({ level: 'mid', title: '噪声投诉', detail: `近 30 天噪声投诉 ${cmap.noise} 起，建议延长夜间静音时段或更换静音机型。` });
  if ((cmap.timeout_no_pickup || 0) >= 2) suggestions.push({ level: 'mid', title: '超时未取频发', detail: `超时未取 ${cmap.timeout_no_pickup} 起，建议缩短宽限、加强提醒或启用保洁代收。` });
  if ((cmap.wrong_pickup || 0) >= 1) suggestions.push({ level: 'mid', title: '错拿申诉', detail: `错拿申诉 ${cmap.wrong_pickup} 起，建议检查摄像头覆盖并张贴分桶提示。` });
  if (!suggestions.length) suggestions.push({ level: 'low', title: '运营平稳', detail: '各项指标正常，暂无调整建议。' });
  res.json({ site: site.name, suggestions });
}));

router.put('/sites/:id/rules', auth, requireRole('property'), ah(async (req, res) => {
  const site = await one('SELECT * FROM sites WHERE id=$1', [req.params.id]);
  if (!site) return bad(res, '门店不存在', 404);
  const rules = { ...site.rules, ...req.body };
  await q('UPDATE sites SET rules=$1 WHERE id=$2', [JSON.stringify(rules), site.id]);
  res.json({ ok: true, rules });
}));

router.post('/devices', auth, requireRole('property'), ah(async (req, res) => {
  const { site_id, zone_id, code, type, capacity_kg, silent = false } = req.body || {};
  if (!site_id || !code || !type || !capacity_kg) return bad(res, '请填写完整设备信息');
  const exist = await one('SELECT id FROM devices WHERE code=$1', [code.toUpperCase()]);
  if (exist) return bad(res, '设备编号已存在');
  const r = await q(
    `INSERT INTO devices(site_id, zone_id, code, type, capacity_kg, silent, disinfected_at, last_cleaned_at) VALUES($1,$2,$3,$4,$5,$6,now(),now()) RETURNING *`,
    [site_id, zone_id || null, code.toUpperCase(), type, capacity_kg, silent]);
  res.json(r.rows[0]);
}));

router.get('/archives', auth, requireRole('property', 'service'), ah(async (req, res) => {
  const siteId = req.query.site_id ? Number(req.query.site_id) : null;
  const p = siteId ? [siteId] : [];
  const w = (col) => (siteId ? `WHERE ${col}=$1` : '');
  const [refunds, repairs, wrongPickups, lostItems, credits, proxyPickups] = await Promise.all([
    many(`SELECT r.*, o.order_no, u.name AS user_name, d.code AS device_code FROM refunds r
          JOIN orders o ON o.id=r.order_id JOIN users u ON u.id=r.user_id JOIN devices d ON d.id=o.device_id
          ${siteId ? 'WHERE o.site_id=$1' : ''} ORDER BY r.id DESC LIMIT 50`, p),
    many(`SELECT r.*, d.code AS device_code, u.name AS technician_name FROM repairs r
          JOIN devices d ON d.id=r.device_id LEFT JOIN users u ON u.id=r.technician_id
          ${siteId ? 'WHERE d.site_id=$1' : ''} ORDER BY r.id DESC LIMIT 50`, p),
    many(`SELECT t.*, u.name AS raised_by_name, d.code AS device_code FROM tickets t
          LEFT JOIN users u ON u.id=t.raised_by LEFT JOIN devices d ON d.id=t.device_id
          WHERE t.type='wrong_pickup' ${siteId ? 'AND t.site_id=$1' : ''} ORDER BY t.id DESC LIMIT 50`, p),
    many(`SELECT l.*, s.name AS site_name, d.code AS device_code FROM lost_items l
          JOIN sites s ON s.id=l.site_id LEFT JOIN devices d ON d.id=l.device_id
          ${w('l.site_id')} ORDER BY l.id DESC LIMIT 50`, p),
    many(`SELECT c.*, u.name AS user_name FROM credit_records c JOIN users u ON u.id=c.user_id
          ORDER BY c.id DESC LIMIT 80`, []),
    many(`SELECT p.*, o.order_no, u.name AS user_name, cl.name AS cleaner_name, d.code AS device_code
          FROM proxy_pickups p JOIN orders o ON o.id=p.order_id JOIN users u ON u.id=p.user_id
          JOIN users cl ON cl.id=p.cleaner_id JOIN devices d ON d.id=p.device_id
          ${siteId ? 'WHERE p.site_id=$1' : ''} ORDER BY p.id DESC LIMIT 50`, p),
  ]);
  res.json({ refunds, repairs, wrongPickups, lostItems, credits, proxyPickups });
}));

router.get('/users', auth, requireRole('property', 'service'), ah(async (req, res) => {
  const rows = await many(
    `SELECT u.id, u.username, u.name, u.role, u.phone, u.credit, u.free_washes, u.package_expires_at, p.name AS package_name,
       (SELECT COUNT(*)::int FROM orders o WHERE o.user_id=u.id) AS order_count,
       (SELECT COUNT(*)::int FROM orders o WHERE o.user_id=u.id AND o.overdue) AS overdue_count
     FROM users u LEFT JOIN packages p ON p.id=u.package_id ORDER BY u.role, u.id`);
  res.json(rows);
}));

router.post('/users/:id/credit', auth, requireRole('property'), ah(async (req, res) => {
  const { delta, reason } = req.body || {};
  if (!delta || !reason) return bad(res, '请填写变动分值与原因');
  const balance = await tx(async (c) => adjustCredit(c, Number(req.params.id), Number(delta), `物业调整：${reason}`, 'manual', null));
  res.json({ ok: true, balance });
}));

/* ================= 我的 ================= */
router.get('/me/credit-records', auth, ah(async (req, res) => {
  res.json(await many('SELECT * FROM credit_records WHERE user_id=$1 ORDER BY id DESC LIMIT 30', [req.user.id]));
}));

router.get('/staff/users', auth, requireRole('service', 'property'), ah(async (req, res) => {
  res.json(await many(`SELECT id, name, role FROM users WHERE role IN ('service','cleaner','maintenance','property') ORDER BY role`));
}));

function roleLabel(r) {
  return { resident: '居民', service: '客服', cleaner: '保洁', maintenance: '维修', property: '物业' }[r] || r;
}
