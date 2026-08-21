-- =========================================================
-- Supabase schema: MKT (Meta Ads) + Sale Online (Lẻ)
-- POC đầu tiên của sáng kiến migrate khỏi Google Sheets.
-- =========================================================

-- ---------- MKT: chi tiêu quảng cáo Meta ----------
create table if not exists mkt_spend (
  id bigint generated always as identity primary key,
  ad_id text not null,
  ad_date date not null,
  campaign_name text not null,
  adset_name text,
  ad_name text,
  brand text,              -- suy ra từ tên chiến dịch: CT/HT/Shidai/TTV
  product text,            -- suy ra từ tên chiến dịch: Nến Bơ/Đồ Thờ
  reach integer,
  impressions integer,
  spend numeric(14,2),
  messages integer,
  ctr numeric(8,4),
  cpc numeric(14,2),
  comments integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ad_id, ad_date)
);
create index if not exists idx_mkt_spend_date on mkt_spend(ad_date);
create index if not exists idx_mkt_spend_campaign on mkt_spend(campaign_name);

-- ---------- Sale Online: danh sách nhân sự Sales đang hoạt động ----------
-- Dropdown cố định cho form mới -- Master cũ có "Sales phụ trách" là text tự do
-- với ~40 giá trị lịch sử, đây là nguyên nhân trực tiếp của bug "Lead Theo Sales".
-- Không FK cột sales_rep vào đây để không chặn migrate dữ liệu lịch sử.
create table if not exists saonl_sales_reps (
  id bigint generated always as identity primary key,
  name text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- Sale Online: hồ sơ khách (Master) ----------
create table if not exists saonl_customers (
  lead_id text primary key,
  created_date date,                     -- Ngày tạo
  source text,                           -- Nguồn khách
  channel text,                          -- Kênh
  sales_rep text,                        -- Sales phụ trách
  ad_id text,                            -- Ad ID / Mã quảng cáo
  name text not null,                    -- Họ tên khách
  phone text,                            -- SĐT
  city text,                             -- Tỉnh/TP
  district text,                         -- Quận/Huyện
  address text,                          -- Địa chỉ
  status text,                           -- Phân loại KH (6 status taxonomy)
  product_need text,                     -- Nhu cầu ban đầu
  last_care_date date,                   -- Ngày chăm sóc cuối (derived từ care_log)
  total_revenue numeric(14,2) default 0, -- Giá trị đơn cộng dồn (derived từ care_log)
  ma_kh text,                            -- Mã KH
  customer_group text,                   -- Nhóm KH
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_saonl_customers_phone on saonl_customers(phone);
create index if not exists idx_saonl_customers_sales on saonl_customers(sales_rep);
create index if not exists idx_saonl_customers_status on saonl_customers(status);

-- ---------- Sale Online: lượt chăm sóc (CRM) ----------
create table if not exists saonl_care_log (
  id bigint generated always as identity primary key,
  customer_id text not null references saonl_customers(lead_id) on delete cascade,
  care_date date not null,
  source text,
  channel text,
  sales_rep text,
  ad_id text,
  status_kh text,                        -- Phân loại KH tại thời điểm chăm sóc
  care_form text,                        -- Hình thức chăm sóc
  content text,                          -- Nội dung trao đổi
  expected_value numeric(14,2),          -- Giá trị tiềm năng
  status text check (status in ('Đang chăm sóc','Chốt đơn','Mất lead','Chăm sóc dài hạn')),
  lost_group text,                       -- Nhóm nguyên nhân mất lead
  lost_reason text,                      -- Nguyên nhân cụ thể
  close_date date,                       -- Ngày chốt
  close_value numeric(14,2),             -- Doanh thu
  created_at timestamptz not null default now()
);
create index if not exists idx_saonl_care_log_customer on saonl_care_log(customer_id);
create index if not exists idx_saonl_care_log_date on saonl_care_log(care_date);
create index if not exists idx_saonl_care_log_close_date on saonl_care_log(close_date);

-- Trigger: cập nhật total_revenue + last_care_date trên saonl_customers mỗi khi care_log thay đổi
create or replace function saonl_refresh_customer_stats() returns trigger as $$
declare
  cid text;
begin
  cid := coalesce(new.customer_id, old.customer_id);
  update saonl_customers c set
    total_revenue = coalesce((select sum(close_value) from saonl_care_log where customer_id=cid and close_value>0),0),
    last_care_date = (select max(care_date) from saonl_care_log where customer_id=cid),
    updated_at = now()
  where c.lead_id = cid;
  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_saonl_care_log_stats on saonl_care_log;
create trigger trg_saonl_care_log_stats
after insert or update or delete on saonl_care_log
for each row execute function saonl_refresh_customer_stats();

-- updated_at auto-touch
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_mkt_spend_touch on mkt_spend;
create trigger trg_mkt_spend_touch before update on mkt_spend
for each row execute function touch_updated_at();

drop trigger if exists trg_saonl_customers_touch on saonl_customers;
create trigger trg_saonl_customers_touch before update on saonl_customers
for each row execute function touch_updated_at();

-- ---------- RLS ----------
-- Dashboard hiện tại đọc trực tiếp bằng anon key (public, không đăng nhập) -- mở read cho anon.
-- Ghi (insert/update/delete) chỉ qua service_role (migration script, sync job, form backend sau này).
alter table mkt_spend enable row level security;
alter table saonl_customers enable row level security;
alter table saonl_care_log enable row level security;
alter table saonl_sales_reps enable row level security;

drop policy if exists "anon read mkt_spend" on mkt_spend;
create policy "anon read mkt_spend" on mkt_spend for select using (true);

drop policy if exists "anon read saonl_customers" on saonl_customers;
create policy "anon read saonl_customers" on saonl_customers for select using (true);

drop policy if exists "anon read saonl_care_log" on saonl_care_log;
create policy "anon read saonl_care_log" on saonl_care_log for select using (true);

drop policy if exists "anon read saonl_sales_reps" on saonl_sales_reps;
create policy "anon read saonl_sales_reps" on saonl_sales_reps for select using (true);

-- Migration 2026-08-21: đã nới rộng reach/impressions/messages/comments từ integer -> bigint
-- (Ad ID 18 chữ số từng bị dò nhầm vào cột Reach do Meta đổi header "Phạm vi tiếp cận" -> "Người tiếp cận",
-- xem supabase-migrate.js -- COL.REACH đã sửa để match cả 2 tên).
alter table mkt_spend alter column reach type bigint;
alter table mkt_spend alter column impressions type bigint;
alter table mkt_spend alter column messages type bigint;
alter table mkt_spend alter column comments type bigint;

-- Migration 2026-08-21 (2): mở quyền INSERT cho anon trên saonl_customers + saonl_care_log,
-- phục vụ form "Thêm khách mới"/"Ghi nhận chăm sóc" ghi thẳng từ client (App Quản Trị MKT/Sale).
-- Rủi ro đã được user xác nhận chấp nhận (app chỉ dùng nội bộ, anon key public không tránh được).
drop policy if exists "anon insert saonl_customers" on saonl_customers;
create policy "anon insert saonl_customers" on saonl_customers for insert to anon with check (true);

drop policy if exists "anon insert saonl_care_log" on saonl_care_log;
create policy "anon insert saonl_care_log" on saonl_care_log for insert to anon with check (true);
