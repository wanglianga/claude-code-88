import { q, tx, one, many } from './db.js';
import { notify, adjustCredit, createTicket, ticketEvent, notifyNextInQueue } from './helpers.js';

/** 通知文案用的时间格式 */
function fmt(d) {
  const t = new Date(d);
  return `${t.getMonth() + 1}月${t.getDate()}日 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

/**
 * 周期任务：保持「用户占用 / 设备状态 / 物业处理」一致
 * 1. 未支付预约 10 分钟自动取消
 * 2. 运行中订单到点自动完成（等价于设备 IoT 回调）
 * 3. 结束前 5 分钟取衣提醒
 * 4. 超时未取 → 标记逾期、扣信用、生成保洁工单、发送首次短信提醒
 * 5. 超时短信重提醒（每 10 分钟一次，最多 3 次）——代取资格的前置条件
 * 6. 代取保管到期前 12 小时提醒用户取回
 * 7. 保管逾期 → 转物业处理并进入遗留物流程
 * 8. 设备状态一致性校正
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

  // 4. 超时未取：标记逾期、扣信用、生成保洁工单、发送首次短信提醒
  const overdue = await q(
    `SELECT o.*, d.code AS device_code FROM orders o JOIN devices d ON d.id=o.device_id
     WHERE o.status='finished' AND o.overdue=false AND o.pickup_deadline < now()`);
  for (const o of overdue.rows) {
    await tx(async (c) => {
      await c.query(`UPDATE orders SET overdue=true, sms_count=1, last_sms_at=now() WHERE id=$1`, [o.id]);
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
    await notify(o.user_id, 'overdue', '取衣已超时', `订单 ${o.order_no} 已超过取衣宽限，信用 -5。请尽快取衣，超时过久将由保洁代收。`);
    await notify(o.user_id, 'sms', '【短信】取衣超时提醒（第 1 次）',
      `【洗衣房短信】您的订单 ${o.order_no}（设备 ${o.device_code}）已超过取衣宽限，请立即取衣。持续超时且有人排队时，保洁将拍照封袋代收入柜。`);
  }

  // 5. 超时短信重提醒（每 10 分钟一次，最多 3 次）
  const smsDue = await q(
    `SELECT o.*, d.code AS device_code FROM orders o JOIN devices d ON d.id=o.device_id
     WHERE o.status='finished' AND o.overdue=true AND o.sms_count < 3
       AND (o.last_sms_at IS NULL OR o.last_sms_at < now()-interval '10 minutes')`);
  for (const o of smsDue.rows) {
    await q('UPDATE orders SET sms_count=sms_count+1, last_sms_at=now() WHERE id=$1', [o.id]);
    await notify(o.user_id, 'sms', `【短信】取衣超时提醒（第 ${o.sms_count + 1} 次）`,
      `【洗衣房短信】您的订单 ${o.order_no}（设备 ${o.device_code}）已超时未取，请立即取衣。持续超时且有人排队时，保洁将拍照封袋代收入柜。`);
  }

  // 6. 代取保管到期前 12 小时提醒用户取回（保管期限提示）
  const keepDue = await q(
    `SELECT * FROM proxy_pickups
     WHERE status='stored' AND keep_reminded=false AND keep_until > now() AND keep_until < now()+interval '12 hours'`);
  for (const p of keepDue.rows) {
    await q('UPDATE proxy_pickups SET keep_reminded=true WHERE id=$1', [p.id]);
    await notify(p.user_id, 'proxy', '【保管提醒】代取衣物即将到期',
      `您的衣物（封袋 ${p.bag_no}，存放柜 ${p.cabinet_no}）将于 ${fmt(p.keep_until)} 到期，请尽快核对封袋编号并扫码取回；逾期将移交物业按遗留物处理。`);
  }

  // 7. 保管逾期 → 转物业处理 + 进入遗留物流程（事务内原子认领，防重复升级）
  const expiredRows = await q(`SELECT * FROM proxy_pickups WHERE status='stored' AND keep_until <= now()`);
  for (const p of expiredRows.rows) {
    const o = await one('SELECT * FROM orders WHERE id=$1', [p.order_id]);
    const upgraded = await tx(async (c) => {
      const r = await c.query(
        `UPDATE proxy_pickups SET status='escalated', escalated_at=now() WHERE id=$1 AND status='stored' RETURNING id`, [p.id]);
      if (!r.rows[0]) return false;
      await c.query(
        `INSERT INTO lost_items(site_id, device_id, order_id, description, found_by, keeper) VALUES($1,$2,$3,$4,$5,'物业仓（保管逾期转入）')`,
        [p.site_id, p.device_id, p.order_id, `代取封袋 ${p.bag_no}（原存放柜 ${p.cabinet_no}）：${o?.mode_name || '衣物'}一袋`, p.cleaner_id]);
      const t = await createTicket(c, {
        type: 'leftover_overdue', orderId: p.order_id, deviceId: p.device_id, siteId: p.site_id,
        title: `保管逾期遗留 · 封袋 ${p.bag_no}`,
        description: `用户超过保管期限未取回代取衣物（封袋 ${p.bag_no}，柜 ${p.cabinet_no}），已转入遗留物流程，请物业跟进处理。`,
        assignedRole: 'property',
      });
      await ticketEvent(c, t.id, null, 'system', '保管逾期自动转物业处理');
      await adjustCredit(c, p.user_id, -5, `代取衣物保管逾期未取（封袋 ${p.bag_no}）`, 'proxy_pickup', p.id);
      return true;
    });
    if (!upgraded) continue;
    await notify(p.user_id, 'proxy', '【逾期】衣物已移交物业遗留物处理',
      `您的代取衣物（封袋 ${p.bag_no}）已超过保管期限，已移交物业按遗留物处理，信用 -5。可在「我的-遗留物」申请认领。`);
    const managers = await many(`SELECT id FROM users WHERE role='property'`);
    for (const m of managers) {
      await notify(m.id, 'proxy', '保管逾期遗留待处理', `封袋 ${p.bag_no}（柜 ${p.cabinet_no}）保管逾期，已转入遗留物流程并生成工单，请跟进。`);
    }
  }

  // 8. 设备状态一致性校正（故障/维修/离线不干预）
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
