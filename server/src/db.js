import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://laundry:laundry123@localhost:5432/laundry',
  max: 10,
});

export async function q(text, params) {
  return pool.query(text, params);
}

export async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

export async function many(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}

/** 在事务中执行 fn(client) */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('resident','service','cleaner','maintenance','property')),
  phone TEXT,
  credit INT NOT NULL DEFAULT 100,
  package_id INT,
  package_expires_at TIMESTAMPTZ,
  free_washes INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS packages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INT NOT NULL,
  discount_pct INT NOT NULL DEFAULT 100,
  free_washes INT NOT NULL DEFAULT 0,
  duration_days INT NOT NULL,
  description TEXT
);
CREATE TABLE IF NOT EXISTS sites (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('dorm','apartment','old_community')),
  address TEXT,
  rules JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS zones (
  id SERIAL PRIMARY KEY,
  site_id INT NOT NULL REFERENCES sites(id),
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  site_id INT NOT NULL REFERENCES sites(id),
  zone_id INT REFERENCES zones(id),
  code TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('washer','dryer')),
  capacity_kg NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','queued','running','finished','fault','maintenance','offline')),
  silent BOOLEAN NOT NULL DEFAULT false,
  detergent_level INT NOT NULL DEFAULT 100,
  disinfected_at TIMESTAMPTZ,
  last_cleaned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wash_modes (
  id SERIAL PRIMARY KEY,
  device_type TEXT NOT NULL,
  name TEXT NOT NULL,
  duration_min INT NOT NULL,
  price_cents INT NOT NULL,
  description TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  order_no TEXT UNIQUE NOT NULL,
  user_id INT NOT NULL REFERENCES users(id),
  device_id INT NOT NULL REFERENCES devices(id),
  site_id INT NOT NULL REFERENCES sites(id),
  mode_id INT REFERENCES wash_modes(id),
  mode_name TEXT,
  duration_min INT,
  price_cents INT NOT NULL,
  discount_cents INT NOT NULL DEFAULT 0,
  amount_cents INT NOT NULL,
  pay_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (pay_status IN ('unpaid','paid','refunded','partial_refunded')),
  pay_method TEXT,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','paid','running','finished','picked','closed','cancelled','expired')),
  reminded BOOLEAN NOT NULL DEFAULT false,
  overdue BOOLEAN NOT NULL DEFAULT false,
  booked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  pickup_deadline TIMESTAMPTZ,
  picked_up_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_device ON orders(device_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_site ON orders(site_id, status);
CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  ticket_no TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  order_id INT REFERENCES orders(id),
  device_id INT REFERENCES devices(id),
  site_id INT REFERENCES sites(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','processing','resolved','closed')),
  priority TEXT NOT NULL DEFAULT 'normal',
  raised_by INT REFERENCES users(id),
  assigned_to INT REFERENCES users(id),
  assigned_role TEXT,
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE TABLE IF NOT EXISTS ticket_events (
  id SERIAL PRIMARY KEY,
  ticket_id INT NOT NULL REFERENCES tickets(id),
  actor_id INT,
  actor_name TEXT,
  action TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refunds (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id),
  ticket_id INT REFERENCES tickets(id),
  user_id INT NOT NULL REFERENCES users(id),
  amount_cents INT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','paid')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_by INT REFERENCES users(id),
  processed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS inspections (
  id SERIAL PRIMARY KEY,
  site_id INT NOT NULL REFERENCES sites(id),
  cleaner_id INT NOT NULL REFERENCES users(id),
  floor_status TEXT NOT NULL,
  filter_status TEXT NOT NULL,
  detergent_status TEXT NOT NULL,
  odor_status TEXT NOT NULL,
  leftover_status TEXT NOT NULL,
  camera_status TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS restocks (
  id SERIAL PRIMARY KEY,
  site_id INT NOT NULL REFERENCES sites(id),
  item TEXT NOT NULL,
  quantity INT NOT NULL,
  operator_id INT REFERENCES users(id),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lost_items (
  id SERIAL PRIMARY KEY,
  site_id INT NOT NULL REFERENCES sites(id),
  device_id INT REFERENCES devices(id),
  order_id INT REFERENCES orders(id),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'stored' CHECK (status IN ('stored','claimed','returned','disposed')),
  found_by INT REFERENCES users(id),
  keeper TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by INT REFERENCES users(id),
  claimed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS credit_records (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  delta INT NOT NULL,
  balance INT NOT NULL,
  reason TEXT NOT NULL,
  ref_type TEXT,
  ref_id INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);
CREATE TABLE IF NOT EXISTS pickup_auths (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id),
  user_id INT NOT NULL REFERENCES users(id),
  cleaner_id INT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'authorized' CHECK (status IN ('authorized','used','expired','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS repairs (
  id SERIAL PRIMARY KEY,
  device_id INT NOT NULL REFERENCES devices(id),
  ticket_id INT REFERENCES tickets(id),
  technician_id INT REFERENCES users(id),
  description TEXT,
  cost_cents INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at TIMESTAMPTZ
);
`;

export async function migrate() {
  await pool.query(SCHEMA);
}
