import bcrypt from 'bcryptjs';
import { one, q } from './db.js';

/** 首次启动时写入演示数据（users 为空才执行） */
export async function seedIfEmpty() {
  const existing = await one('SELECT id FROM users LIMIT 1');
  if (existing) return false;

  const hash = bcrypt.hashSync('123456', 10);
  const users = [
    ['resident1', '张伟', 'resident', '13800000001', 100],
    ['resident2', '李娜', 'resident', '13800000002', 96],
    ['resident3', '王强', 'resident', '13800000003', 55],
    ['service1', '王客服', 'service', '13800000011', 100],
    ['cleaner1', '刘保洁', 'cleaner', '13800000012', 100],
    ['repair1', '赵维修', 'maintenance', '13800000013', 100],
    ['property1', '物业周经理', 'property', '13800000014', 100],
  ];
  const uid = {};
  for (const [username, name, role, phone, credit] of users) {
    const r = await q(
      'INSERT INTO users(username, password_hash, name, role, phone, credit) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [username, hash, name, role, phone, credit]
    );
    uid[username] = r.rows[0].id;
  }

  // 会员套餐
  await q(`INSERT INTO packages(name, price_cents, discount_pct, free_washes, duration_days, description) VALUES
    ('月卡', 3000, 90, 0, 30, '30 天内洗衣/烘干 9 折'),
    ('季卡', 8000, 80, 2, 90, '90 天内 8 折，另赠 2 次免费标准洗'),
    ('次卡·5次', 2000, 100, 5, 60, '5 次免费标准洗，60 天有效')`);
  // 张伟是季卡会员
  await q(`UPDATE users SET package_id=(SELECT id FROM packages WHERE name='季卡'), package_expires_at=now()+interval '60 days', free_washes=2 WHERE username='resident1'`);

  // 三个不同运营规则的门店
  const dormRules = {
    nightSilent: { enabled: true, start: '23:00', end: '06:30' },
    allowNightStart: false,
    peakPricing: [{ start: '18:00', end: '22:00', multiplier: 1.2, label: '晚高峰加价' }],
    offPeak: [{ start: '08:00', end: '11:00', multiplier: 0.8, label: '早间错峰 8 折' }],
    pickupGraceMin: 30,
    maxDailyOrdersPerUser: 4,
    occupationLimitMin: 180,
    minCreditToBook: 60,
    note: '学生宿舍：夜间静音、晚高峰人多，鼓励早间错峰',
  };
  const aptRules = {
    nightSilent: { enabled: true, start: '22:00', end: '07:00' },
    allowNightStart: true,
    peakPricing: [{ start: '19:00', end: '23:00', multiplier: 1.15, label: '晚间高峰' }],
    offPeak: [{ start: '09:00', end: '16:00', multiplier: 0.85, label: '白天错峰 85 折' }],
    pickupGraceMin: 45,
    maxDailyOrdersPerUser: 6,
    occupationLimitMin: 240,
    minCreditToBook: 60,
    note: '青年公寓：白天错峰优惠，夜间仅静音机型可启动',
  };
  const oldRules = {
    nightSilent: { enabled: true, start: '21:30', end: '07:30' },
    allowNightStart: false,
    peakPricing: [],
    offPeak: [{ start: '13:00', end: '16:00', multiplier: 0.9, label: '午后 9 折' }],
    pickupGraceMin: 60,
    maxDailyOrdersPerUser: 3,
    occupationLimitMin: 300,
    minCreditToBook: 70,
    note: '老旧小区：邻里噪声敏感、限时用水，取衣宽限更长',
  };
  const s1 = await q(`INSERT INTO sites(name, kind, address, rules) VALUES('青松苑 3 栋洗衣房','dorm','青松苑学生宿舍 3 栋 1 层',$1) RETURNING id`, [JSON.stringify(dormRules)]);
  const s2 = await q(`INSERT INTO sites(name, kind, address, rules) VALUES('蓝湾公寓共享洗衣房','apartment','蓝湾公寓 B 座地下 1 层',$1) RETURNING id`, [JSON.stringify(aptRules)]);
  const s3 = await q(`INSERT INTO sites(name, kind, address, rules) VALUES('幸福里小区洗衣点','old_community','幸福里小区 7 号楼旁',$1) RETURNING id`, [JSON.stringify(oldRules)]);
  const site1 = s1.rows[0].id, site2 = s2.rows[0].id, site3 = s3.rows[0].id;

  const z1 = await q(`INSERT INTO zones(site_id, name) VALUES($1,'A 区·滚筒') RETURNING id`, [site1]);
  const z2 = await q(`INSERT INTO zones(site_id, name) VALUES($1,'B 区·烘干') RETURNING id`, [site1]);
  const z3 = await q(`INSERT INTO zones(site_id, name) VALUES($1,'A 区·洗烘') RETURNING id`, [site2]);
  const z4 = await q(`INSERT INTO zones(site_id, name) VALUES($1,'B 区·大容量') RETURNING id`, [site2]);
  const z5 = await q(`INSERT INTO zones(site_id, name) VALUES($1,'洗衣区') RETURNING id`, [site3]);
  const zone1 = z1.rows[0].id, zone2 = z2.rows[0].id, zone3 = z3.rows[0].id, zone4 = z4.rows[0].id, zone5 = z5.rows[0].id;

  // 设备：编号 / 类型 / 容量 / 状态 / 静音 / 洗衣液余量
  const devices = [
    [site1, zone1, 'QS-W101', 'washer', 8, 'idle', false, 90],
    [site1, zone1, 'QS-W102', 'washer', 8, 'running', false, 55],
    [site1, zone1, 'QS-W103', 'washer', 10, 'idle', true, 100],
    [site1, zone2, 'QS-D201', 'dryer', 9, 'idle', false, 100],
    [site1, zone2, 'QS-D202', 'dryer', 9, 'fault', false, 100],
    [site2, zone3, 'LW-W101', 'washer', 10, 'idle', true, 80],
    [site2, zone3, 'LW-W102', 'washer', 8, 'finished', false, 15],
    [site2, zone3, 'LW-D201', 'dryer', 9, 'idle', true, 100],
    [site2, zone4, 'LW-W201', 'washer', 13, 'maintenance', false, 100],
    [site3, zone5, 'XF-W101', 'washer', 8, 'idle', true, 70],
    [site3, zone5, 'XF-W102', 'washer', 8, 'idle', false, 30],
    [site3, zone5, 'XF-D201', 'dryer', 9, 'offline', false, 100],
  ];
  const did = {};
  for (const [site, zone, code, type, cap, status, silent, det] of devices) {
    const r = await q(
      `INSERT INTO devices(site_id, zone_id, code, type, capacity_kg, status, silent, detergent_level, disinfected_at, last_cleaned_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8, now()-interval '2 hours', now()-interval '5 hours') RETURNING id`,
      [site, zone, code, type, cap, status, silent, det]
    );
    did[code] = r.rows[0].id;
  }

  // 洗涤模式
  await q(`INSERT INTO wash_modes(device_type, name, duration_min, price_cents, description) VALUES
    ('washer','快洗 15 分钟',15,300,'轻污衣物快速洗涤'),
    ('washer','标准洗 35 分钟',35,500,'日常衣物标准程序'),
    ('washer','强力洗 45 分钟',45,650,'重污/床单被罩'),
    ('washer','轻柔洗 30 分钟',30,550,'羊毛/真丝等娇贵面料'),
    ('dryer','烘干 30 分钟',30,400,'薄衣快烘'),
    ('dryer','烘干 60 分钟',60,600,'厚衣/被褥深度烘干')`);

  const mode = {};
  const modes = await q('SELECT id, name, duration_min, price_cents FROM wash_modes');
  for (const m of modes.rows) mode[m.name] = m;

  // ---- 进行中的演示订单 ----
  // QS-W102 李娜标准洗，运行中，8 分钟后结束
  const o1 = await q(
    `INSERT INTO orders(order_no, user_id, device_id, site_id, mode_id, mode_name, duration_min, price_cents, amount_cents, pay_status, pay_method, status, booked_at, paid_at, started_at, ends_at)
     VALUES('LD20260916001',$1,$2,$3,$4,'标准洗 35 分钟',35,500,500,'paid','wechat','running', now()-interval '30 minutes', now()-interval '29 minutes', now()-interval '27 minutes', now()+interval '8 minutes') RETURNING id`,
    [uid.resident2, did['QS-W102'], site1, mode['标准洗 35 分钟'].id]
  );
  // LW-W102 张伟快洗已完成，等待取衣，12 分钟后超时
  const o2 = await q(
    `INSERT INTO orders(order_no, user_id, device_id, site_id, mode_id, mode_name, duration_min, price_cents, amount_cents, pay_status, pay_method, status, booked_at, paid_at, started_at, ends_at, finished_at, pickup_deadline)
     VALUES('LD20260916002',$1,$2,$3,$4,'快洗 15 分钟',15,300,240,'paid','alipay','finished', now()-interval '40 minutes', now()-interval '39 minutes', now()-interval '35 minutes', now()-interval '20 minutes', now()-interval '18 minutes', now()+interval '12 minutes') RETURNING id`,
    [uid.resident1, did['LW-W102'], site2, mode['快洗 15 分钟'].id]
  );
  // QS-W101 排队中的已支付订单（王强）
  await q(
    `INSERT INTO orders(order_no, user_id, device_id, site_id, mode_id, mode_name, duration_min, price_cents, amount_cents, pay_status, pay_method, status, booked_at, paid_at)
     VALUES('LD20260916003',$1,$2,$3,$4,'标准洗 35 分钟',35,500,500,'paid','wechat','paid', now()-interval '10 minutes', now()-interval '9 minutes')`,
    [uid.resident3, did['QS-W101'], site1, mode['标准洗 35 分钟'].id]
  );

  // ---- 历史订单（用于利用率统计）----
  for (let i = 0; i < 40; i++) {
    const devIds = [did['QS-W101'], did['QS-W102'], did['QS-W103'], did['QS-D201'], did['LW-W101'], did['XF-W101']];
    const d = devIds[i % devIds.length];
    const dev = await one('SELECT * FROM devices WHERE id=$1', [d]);
    const m = dev.type === 'washer' ? mode['标准洗 35 分钟'] : mode['烘干 30 分钟'];
    const u = [uid.resident1, uid.resident2, uid.resident3][i % 3];
    await q(
      `INSERT INTO orders(order_no, user_id, device_id, site_id, mode_id, mode_name, duration_min, price_cents, amount_cents, pay_status, pay_method, status, booked_at, paid_at, started_at, ends_at, finished_at, pickup_deadline, picked_up_at, closed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,'paid','wechat','closed',
         now()- ($9 || ' hours')::interval, now()- ($9 || ' hours')::interval, now()- ($9 || ' hours')::interval,
         now()- (($9::int - 1) || ' hours')::interval, now()- (($9::int - 1) || ' hours')::interval,
         now()- (($9::int - 2) || ' hours')::interval, now()- (($9::int - 2) || ' hours')::interval, now()- (($9::int - 2) || ' hours')::interval)`,
      [`LD2026090${String(100 + i)}`, u, d, dev.site_id, m.id, m.name, m.duration_min, m.price_cents, String(20 + i * 3)]
    );
  }

  // ---- 演示工单 ----
  const t1 = await q(
    `INSERT INTO tickets(ticket_no, type, order_id, device_id, site_id, title, description, status, priority, raised_by, assigned_role)
     VALUES('TK20260916001','wrong_pickup',$1,$2,$3,'我的黑色卫衣被错拿了','订单完成后取衣时发现桶内不是自己的衣物，疑似被上一位用户错拿。','processing','high',$4,'service') RETURNING id`,
    [o2.rows[0].id, did['LW-W102'], site2, uid.resident1]
  );
  await q(`INSERT INTO ticket_events(ticket_id, actor_id, actor_name, action, note) VALUES
    ($1,$2,'张伟','create','用户提交错拿申诉'),
    ($1,$3,'王客服','assign','客服已受理，正在联系同设备前后订单用户'),
    ($1,$3,'王客服','note','已调取摄像头时段 14:20-14:50，待保洁现场确认遗留衣物')`,
    [t1.rows[0].id, uid.resident1, uid.service1]);
  await q(
    `INSERT INTO tickets(ticket_no, type, device_id, site_id, title, description, status, priority, assigned_role)
     VALUES('TK20260916002','detergent_low',$1,$2,'LW-W102 洗衣液不足','设备洗衣液余量低于 20%，请及时补充。','open','normal','cleaner')`,
    [did['LW-W102'], site2]
  );
  await q(
    `INSERT INTO tickets(ticket_no, type, device_id, site_id, title, description, status, priority, raised_by, assigned_role)
     VALUES('TK20260916003','device_fault',$1,$2,'QS-D202 烘干不干','用户反馈烘干 60 分钟后衣物仍潮湿，疑似加热管故障。','assigned','high',$3,'maintenance')`,
    [did['QS-D202'], site1, uid.resident2]
  );
  await q(`UPDATE tickets SET assigned_to=$1 WHERE ticket_no='TK20260916003'`, [uid.repair1]);
  await q(
    `INSERT INTO tickets(ticket_no, type, site_id, title, description, status, priority, raised_by, assigned_role)
     VALUES('TK20260916004','noise',$1,'夜间洗衣噪声扰民','7 号楼住户反映 23 点后仍有设备运行噪声，建议调整静音时段。','open','normal',$2,'property')`,
    [site3, uid.resident2]
  );

  // ---- 保洁巡检记录 ----
  await q(
    `INSERT INTO inspections(site_id, cleaner_id, floor_status, filter_status, detergent_status, odor_status, leftover_status, camera_status, note, created_at) VALUES
     ($1,$2,'正常','正常','不足','轻微异味','有遗留','正常','A 区地面已拖洗，LW-W102 洗衣液待补；发现遗留衣物一袋已登记。', now()-interval '3 hours'),
     ($3,$2,'正常','积絮','正常','正常','无','正常','QS-D201 滤网已清理。', now()-interval '26 hours')`,
    [site2, uid.cleaner1, site1]
  );

  // ---- 遗留物 ----
  await q(
    `INSERT INTO lost_items(site_id, device_id, description, status, found_by, keeper, created_at) VALUES
     ($1,$2,'灰色连帽卫衣一件（L 码）','stored',$3,'保洁柜 A-2', now()-interval '3 hours'),
     ($4,$5,'黑色袜子一双','claimed',$3,'保洁柜 A-2', now()-interval '2 days')`,
    [site2, did['LW-W102'], uid.cleaner1, site1, did['QS-W101']]
  );

  // ---- 退款档案 ----
  const ro = await q(
    `INSERT INTO orders(order_no, user_id, device_id, site_id, mode_id, mode_name, duration_min, price_cents, amount_cents, pay_status, pay_method, status, booked_at, paid_at, started_at, ends_at, closed_at)
     VALUES('LD20260915001',$1,$2,$3,$4,'烘干 60 分钟',60,600,600,'refunded','wechat','cancelled', now()-interval '1 day', now()-interval '1 day', now()-interval '1 day', now()-interval '23 hours', now()-interval '22 hours') RETURNING id`,
    [uid.resident2, did['QS-D202'], site1, mode['烘干 60 分钟'].id]
  );
  await q(
    `INSERT INTO refunds(order_id, user_id, amount_cents, reason, status, requested_at, processed_by, processed_at)
     VALUES($1,$2,600,'烘干不干，设备故障','paid', now()-interval '23 hours',$3, now()-interval '22 hours')`,
    [ro.rows[0].id, uid.resident2, uid.service1]
  );

  // ---- 维修档案 ----
  await q(
    `INSERT INTO repairs(device_id, technician_id, description, cost_cents, status, created_at, done_at) VALUES
     ($1,$2,'更换排水泵，清理排水管异物',8000,'done', now()-interval '5 days', now()-interval '5 days')`,
    [did['QS-W102'], uid.repair1]
  );

  // ---- 信用档案 ----
  await q(
    `INSERT INTO credit_records(user_id, delta, balance, reason, ref_type, created_at) VALUES
     ($1,-5,95,'超时未取衣（宽限 30 分钟）','order', now()-interval '6 days'),
     ($1,-10,85,'恶意占用：预约后未支付超 3 次','system', now()-interval '4 days'),
     ($1,-20,65,'错拿他人物品且未及时归还','ticket', now()-interval '3 days'),
     ($1,-10,55,'夜间静音时段强行启动设备','system', now()-interval '2 days'),
     ($2,2,98,'按时取衣，秩序良好','order', now()-interval '1 days'),
     ($3,-2,98,'取衣超时 10 分钟','order', now()-interval '2 days')`,
    [uid.resident3, uid.resident1, uid.resident2]
  );
  await q(`UPDATE users SET credit=98 WHERE id=$1`, [uid.resident1]);
  await q(`UPDATE users SET credit=98 WHERE id=$1`, [uid.resident2]);

  // ---- 补货记录 ----
  await q(
    `INSERT INTO restocks(site_id, item, quantity, operator_id, note, created_at) VALUES
     ($1,'洗衣液',20,$2,'A 区两台设备加满', now()-interval '2 days'),
     ($3,'消毒液',10,$2,'公共区域消毒补充', now()-interval '4 days')`,
    [site2, uid.cleaner1, site1]
  );

  console.log('[seed] 演示数据已写入');
  return true;
}
