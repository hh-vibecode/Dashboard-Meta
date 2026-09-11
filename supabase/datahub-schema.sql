-- =========================================================================
-- Data Hub v2: crawl thẳng từ Pancake POS API, thay cho luồng cũ
-- (Sale tự export/nhập tay vào Google Sheet rồi Dashboard mới đọc CSV từ Sheet đó).
-- Field mapping đã đối chiếu 1-1 với sheet DataHub cũ (gid=1118746473, tab "Nguồn Online") 22/9-11/9:
--   Ngày tạo đơn    = order.inserted_at
--   Mã đơn hàng     = order.system_id
--   Khách mới/cũ    = suy từ customer.order_count (<=1 → Mới)
--   Thẻ khách hàng  = customer.tags (join ", ")
--   Khách hàng      = customer.name
--   SĐT/Địa chỉ/... = order.shipping_address.*
--   Nguồn đơn       = order.order_sources_name + " / " + order.account_name + " (" + order.account + ")"
--   Ghi chú nội bộ  = order.note
--   Nhân viên cập nhật = order.creator.name
--   Ad ID           = order.ad_id  (Pancake trả sẵn, không cần suy luận qua Ads ID campaign)
-- =========================================================================

create table if not exists datahub_orders (
  id bigint generated always as identity primary key,
  shop_id bigint not null,
  shop_name text,
  brand text,                        -- CT/HT/Shidai/TTV/Other -- map cứng theo shop_id (xem sync-datahub-pancake.js), KHÔNG suy qua regex tên vì "Thời Đại" không chứa chữ "Shidai"
  order_id bigint not null,          -- id nội bộ Pancake (khác system_id hiển thị)
  system_id bigint not null,         -- "Mã đơn hàng" hiển thị cho Sale, tăng dần riêng theo từng shop
  order_date date not null,          -- "Ngày tạo đơn"
  customer_status text,              -- "Khách mới/cũ": Mới | Cũ
  customer_tags text,                -- "Thẻ khách hàng"
  customer_name text,                -- "Khách hàng"
  phone text,
  address text,
  ward text,                         -- "Phường/Xã"
  district text,                     -- "Quận/Huyện"
  province text,                     -- "Tỉnh/Thành phố"
  source text,                       -- "Nguồn đơn"
  internal_note text,                -- "Ghi chú nội bộ"
  staff_name text,                   -- "Nhân viên cập nhật"
  ad_id text,
  order_status text,                 -- status_name thô từ Pancake, phòng khi cần lọc đơn huỷ/hoàn sau này
  pancake_updated_at timestamptz,    -- order.updated_at -- dùng để sync incremental (chỉ lấy đơn đổi từ lần trước)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(shop_id, order_id)
);
create index if not exists idx_datahub_orders_date on datahub_orders(order_date);
create index if not exists idx_datahub_orders_brand on datahub_orders(brand);
create index if not exists idx_datahub_orders_phone on datahub_orders(phone);
create index if not exists idx_datahub_orders_adid on datahub_orders(ad_id);

create or replace function touch_datahub_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;
drop trigger if exists trg_datahub_orders_touch on datahub_orders;
create trigger trg_datahub_orders_touch before update on datahub_orders
for each row execute function touch_datahub_updated_at();

alter table datahub_orders enable row level security;
drop policy if exists "anon read datahub_orders" on datahub_orders;
create policy "anon read datahub_orders" on datahub_orders for select using (true);
-- Ghi chỉ qua service_role (sync job GitHub Actions) -- không cho anon insert/update, khác saonl_customers
-- (data Hub là nguồn SYSTEM đổ vào, không phải nơi Sale tự nhập tay qua app).

create table if not exists datahub_sync_log (
  id bigint generated always as identity primary key,
  shop_id bigint,
  shop_name text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  records_created int not null default 0,
  records_updated int not null default 0,
  status text not null default 'running' check (status in ('running','success','failed')),
  error_message text
);
alter table datahub_sync_log enable row level security;
drop policy if exists "anon read datahub_sync_log" on datahub_sync_log;
create policy "anon read datahub_sync_log" on datahub_sync_log for select using (true);
