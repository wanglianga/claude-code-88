export type Role = 'resident' | 'service' | 'cleaner' | 'maintenance' | 'property';

export interface User {
  id: number;
  username: string;
  name: string;
  role: Role;
  phone?: string;
  credit: number;
  package_id?: number | null;
  package_expires_at?: string | null;
  free_washes: number;
  package?: { name: string; discount_pct: number } | null;
}

export interface PriceRule { start: string; end: string; multiplier: number; label: string }

export interface SiteRules {
  nightSilent?: { enabled: boolean; start: string; end: string };
  allowNightStart?: boolean;
  peakPricing?: PriceRule[];
  offPeak?: PriceRule[];
  pickupGraceMin?: number;
  maxDailyOrdersPerUser?: number;
  occupationLimitMin?: number;
  minCreditToBook?: number;
  note?: string;
}

export interface Site {
  id: number; name: string; kind: 'dorm' | 'apartment' | 'old_community';
  address: string; rules: SiteRules;
}

export interface Zone { id: number; site_id: number; name: string }

export interface WashMode {
  id: number; device_type: 'washer' | 'dryer'; name: string;
  duration_min: number; price_cents: number; description: string;
}

export type DeviceStatus = 'idle' | 'queued' | 'running' | 'finished' | 'fault' | 'maintenance' | 'offline';

export interface CurrentOrder {
  order_id: number; order_no: string; mode_name: string; status: string;
  ends_at?: string; finished_at?: string; pickup_deadline?: string;
  overdue: boolean; user_name: string; mine: boolean;
}

export interface QueueItem { id: number; order_no: string; user_name: string; paid_at: string }

export interface Inspection {
  id: number; site_id: number; cleaner_id: number; cleaner_name?: string; site_name?: string;
  floor_status: string; filter_status: string; detergent_status: string;
  odor_status: string; leftover_status: string; camera_status: string;
  note?: string; created_at: string;
}

export interface Device {
  id: number; site_id: number; zone_id: number | null; zone_name: string;
  code: string; type: 'washer' | 'dryer'; capacity_kg: number;
  status: DeviceStatus; silent: boolean; detergent_level: number;
  disinfected_at: string | null; last_cleaned_at: string | null;
  current_order: CurrentOrder | null; queue: QueueItem[]; queue_count: number;
  modes: WashMode[]; last_inspection: Inspection | null;
}

export interface Board { site: Site; zones: Zone[]; devices: Device[]; night_now: boolean }

export interface Order {
  id: number; order_no: string; user_id: number; device_id: number; site_id: number;
  mode_name: string; duration_min: number; price_cents: number; discount_cents: number; amount_cents: number;
  pay_status: string; pay_method?: string; status: string; reminded: boolean; overdue: boolean;
  booked_at: string; paid_at?: string; started_at?: string; ends_at?: string;
  finished_at?: string; pickup_deadline?: string; picked_up_at?: string; closed_at?: string;
  device_code?: string; device_type?: string; site_name?: string; silent?: boolean;
  queue_position?: number | null; queue_count?: number;
  lost_item?: { id: number; status: string; keeper: string } | null;
  pickup_auth?: { id: number; status: string } | null;
  rules?: SiteRules;
}

export interface Ticket {
  id: number; ticket_no: string; type: string; order_id?: number; device_id?: number; site_id?: number;
  title: string; description?: string; status: string; priority: string;
  raised_by?: number; raised_by_name?: string; assigned_to?: number; assigned_to_name?: string; assigned_role?: string;
  resolution?: string; created_at: string; updated_at: string;
  device_code?: string; order_no?: string; site_name?: string; order_status?: string;
  events?: TicketEvent[]; refund?: Refund | null;
}

export interface TicketEvent { id: number; action: string; note: string; actor_name: string; created_at: string }

export interface Refund {
  id: number; order_id: number; ticket_id?: number; user_id: number; amount_cents: number;
  reason?: string; status: string; requested_at: string; processed_by?: number; processed_at?: string;
  order_no?: string; user_name?: string; device_code?: string; mode_name?: string;
}

export interface LostItem {
  id: number; site_id: number; device_id?: number; order_id?: number; description: string;
  status: string; keeper?: string; created_at: string; claimed_by?: number; claimed_at?: string;
  site_name?: string; device_code?: string; order_no?: string; owner_name?: string; claimed_by_name?: string;
}

export interface CreditRecord { id: number; delta: number; balance: number; reason: string; created_at: string }

export interface Notification { id: number; type: string; title: string; body: string; read: boolean; created_at: string }

export interface Package { id: number; name: string; price_cents: number; discount_pct: number; free_washes: number; duration_days: number; description: string }

export interface Quote {
  base: number; multiplier: number; multiplierLabel: string | null; afterMultiplier: number;
  discountPct: number; memberLabel: string | null; amount: number; discount: number;
  free_wash_available: boolean; free_washes: number;
}

export interface StaffUser { id: number; name: string; role: Role }
