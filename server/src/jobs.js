import { q, tx, one } from './db.js';
import { notify, adjustCredit, createTicket, ticketEvent, notifyNextInQueue, sendSms } from './helpers.js';

/**
 * 周期任务：保持「用户占用 / 设备状态 / 物业处理」一致
 * 1. 未支付预约 10 分钟自动取消
 * 2. 运行中订单到点自动完成（等价于设备 IoT 回调）
 * 3. 结束前 5 分钟取衣提醒
 * 4. 超时未取 → 标记逾期、扣信用、发短信提醒、生成保洁工单
 * 5. 代取保管：到期前提醒用户，逾期移交物业并进入遗留物流程
 * 6. 设备状态一致性校正
 */
export function startJobs() {
  const tick = async () => {
    try {
      await sweep();
    } catch (e) {
      console.error('[jobs] sweep error:', e.message);
    }
  };
  setInterval(tick, 15000);
  setTimeout(tick, 3000);
}

async function sweep() {
  // 1. 未支付超时取消
  const unpaid = await q(
    `UPDATE orders SET status='cancelled', closed_at=now()
     WHERE status='booked' AND pay_status='unpaid' AND booked_at < now()-interval '10 minutes' RETURNING id, user_id, order_no`);
  for (const o of unpaid.rows) {
    await notify(o.user_id, 'order', '预约已超时取消', `订单 ${o.order_no} 未在 10 分钟内支付，已自动取消。`);
  }

  // 2. 到点自动完成
  const done = await q(
    `SELECT o.*, d.code AS device_code FROM orders o JOIN devices d ON d.id=o.device_id
     WHERE o.status='running' AND o.ends_at <= now()`);
  for (const o of done.rows) {
    const site = await one('SELECT rules FROM sites WHERE id=$1', [o.site_id]);
    const grace = site?.rules?.pickupGraceMin ?? 30;
    await tx(async (c) => {
      await c.query(`UPDATE orders SET status='finished', finished_at=now(), pickup_deadline=now()+($1 || ' minutes')::interval WHERE id=$2 AND status='running'`, [String(grace), o.id]);
      await c.query(`UPDATE devices SET status='finished' WHERE id=$1`, [o.device_id]);
    });
    await notify(o.user_id, 'finish', '洗涤完成，请及时取衣', `设备 ${o.device_code} 的「${o.mode_name}」已结束，请在 ${grace} 分钟内取衣。`);
  }

  // 3. 结束前 5 分钟提醒
  const soon = await q(
    `SELECT o.*, d.code AS device_code FROM orders o JOIN devices d ON d.id=o.device_id
     WHERE o.status='running' AND o.reminded=false AND o.ends_at <= now()+interval '5 minutes' AND o.ends_at > now()`);
  for (const o of soon.rows) {
    await q('UPDATE orders SET reminded=true WHERE id=$1', [o.id]);
    await notify(o.user_id, 'remind', '即将结束提醒', `设备 ${o.device_code} 的「${o.mode_name}」将在约 5 分钟内结束，请准备前往取衣。`);
  }

  // 4. 超时未取
  const overdue = await q(
    `SELECT o.*, d.code AS device_code, u.phone AS user_phone FROM orders o
     JOIN devices d ON d.id=o.device_id JOIN users u ON u.id=o.user_id
     WHERE o.status='finished' AND o.overdue=false AND o.pickup_deadline < now()`);
  for (const o of overdue.rows) {
    await tx(async (c) => {
      await c.query('UPDATE orders SET overdue=true WHERE id=$1', [o.id]);
      await adjustCredit(c, o.user_id, -5, `超时未取衣（订单 ${o.order_no}）`, 'order', o.id);
      const exist = await c.query(`SELECT id FROM tickets WHERE order_id=$1 AND type='timeout_no_pickup' AND status IN ('open','assigned','processing')`, [o.id]);
      if (!exist.rows[0]) {
        const t = await createTicket(c, {
          type: 'timeout_no_pickup', orderId: o.id, deviceId: o.device_id, siteId: o.site_id,
          title: `超时未取 · ${o.device_code} · ${o.order_no}`,
          description: '用户超过取衣宽限时间未取衣，请保洁现场核实并代收衣物，释放设备。',
          assignedRole: 'cleaner',
        });
        await ticketEvent(c, t.id, null, 'system', '系统自动生成超时工单');
      }
    });
    // 短信提醒（代取资格判断以该短信发送时间为准）
    await sendSms(o.user_id, 'timeout_warn',
      `【净邻洗衣】您的订单 ${o.order_no}（设备 ${o.device_code}）已超过取衣宽限，信用 -5。请立即取衣，超时过久保洁将代取封存并移交保管柜。`,
      'order', o.id);
    await notify(o.user_id, 'overdue', '取衣已超时（短信已提醒）', `订单 ${o.order_no} 已超过取衣宽限，信用 -5，提醒短信已发送至 ${o.user_phone}。请尽快取衣，超时过久将由保洁代取封存。`);
  }

  // 5a. 代取保管到期前提醒（保管期限会提示用户）
  const expiring = await q(
    `SELECT p.*, s.rules FROM proxy_pickups p JOIN sites s ON s.id=p.site_id
     WHERE p.status='stored' AND p.remind_sent=false
       AND p.store_until <= now() + (COALESCE((s.rules->>'storageRemindBeforeHours')::int, 24) || ' hours')::interval
       AND p.store_until > now()`);
  for (const p of expiring.rows) {
    await q('UPDATE proxy_pickups SET remind_sent=true WHERE id=$1', [p.id]);
    const hoursLeft = Math.max(1, Math.round((new Date(p.store_until) - Date.now()) / 3600000));
    await sendSms(p.user_id, 'storage_expiring',
      `【净邻洗衣】您的代取衣物（封袋 ${p.bag_no}，${p.cabinet_no} 柜）保管期限仅剩约 ${hoursLeft} 小时，请尽快凭取件码取回，逾期将移交物业处理。`,
      'proxy_pickup', p.id);
    await notify(p.user_id, 'proxy', '保管期限将至，请尽快取回',
      `封袋 ${p.bag_no}（${p.cabinet_no} 柜）保管期限仅剩约 ${hoursLeft} 小时。请在「我的-代取任务」核对封袋编号并扫码取回，逾期将移交物业进入遗留物流程。`);
  }

  // 5b. 代取保管逾期 → 移交物业，进入遗留物流程
  const expiredPickups = await q(
    `SELECT p.*, d.code AS device_code FROM proxy_pickups p JOIN devices d ON d.id=p.device_id
     WHERE p.status='stored' AND p.store_until <= now()`);
  for (const p of expiredPickups.rows) {
    await tx(async (c) => {
      const done = await c.query(
        `UPDATE proxy_pickups SET status='escalated', escalated_at=now() WHERE id=$1 AND status='stored' RETURNING id`, [p.id]);
      if (!done.rows[0]) return;
      // 进入遗留物流程：生成遗留物档案（物业保管）
      await c.query(
        `INSERT INTO lost_items(site_id, device_id, order_id, description, found_by, keeper) VALUES($1,$2,$3,$4,$5,'物业保管柜')`,
        [p.site_id, p.device_id, p.order_id, `代取逾期衣物（封袋 ${p.bag_no}，原存 ${p.cabinet_no} 柜）`, p.cleaner_id]);
      // 生成物业处理工单
      const t = await createTicket(c, {
        type: 'lost_escalation', orderId: p.order_id, deviceId: p.device_id, siteId: p.site_id,
        title: `代取衣物逾期移交物业 · 封袋 ${p.bag_no}`,
        description: `代取单 ${p.pickup_no}（封袋 ${p.bag_no}，柜号 ${p.cabinet_no}）保管 ${p.storage_hours} 小时期满用户未取回，衣物已转入物业保管柜，请物业按遗留物规定处理。`,
        priority: 'normal', assignedRole: 'property',
      });
      await ticketEvent(c, t.id, null, 'system', '保管期满，系统自动移交物业');
    });
    await sendSms(p.user_id, 'escalated',
      `【净邻洗衣】您的代取衣物（封袋 ${p.bag_no}）已超过保管期限，现已移交物业按遗留物处理，请在「我的-遗留物」申请认领。`,
      'proxy_pickup', p.id);
    await notify(p.user_id, 'proxy', '保管已逾期，衣物移交物业',
      `封袋 ${p.bag_no} 超过 ${p.storage_hours} 小时保管期限未取回，已移交物业进入遗留物流程。请在「我的-遗留物」申请认领，由物业核实后交接。`);
  }

  // 5. 设备状态一致性校正（故障/维修/离线不干预）
  await q(
    `UPDATE devices d SET status='idle'
     WHERE d.status IN ('running','finished')
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.device_id=d.id AND o.status IN ('running','finished'))
       AND d.status NOT IN ('fault','maintenance','offline')`);
  // 队列漂移校正：退款/取消后 queued 设备已无已支付订单 → 回到空闲
  await q(
    `UPDATE devices d SET status='idle'
     WHERE d.status='queued'
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.device_id=d.id AND o.status='paid')`);
  await q(
    `UPDATE devices d SET status='queued'
     WHERE d.status='idle' AND EXISTS (SELECT 1 FROM orders o WHERE o.device_id=d.id AND o.status='paid')`);
}
