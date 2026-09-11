// Đồng bộ đơn hàng từ Pancake POS API thẳng vào Supabase bảng datahub_orders -- thay cho luồng cũ
// (Sale tự export/copy vào Google Sheet "DataHub" rồi Dashboard mới đọc CSV từ Sheet đó).
//
// Cần 2 biến môi trường:
//   PANCAKE_SESSION_TOKEN     -- token đăng nhập Pancake (dạng JWT, hết hạn 1/11/2026), xem được TẤT CẢ
//     shop trong tài khoản Pancake THT Holding. Khi hết hạn phải đăng nhập lại Pancake lấy token mới.
//   SUPABASE_SERVICE_ROLE_KEY -- ghi vào Supabase (bỏ qua RLS)
//
// Chạy mặc định (KHÔNG set BACKFILL): chỉ quét 5 trang mới nhất/shop (~500 đơn) -- đủ bắt mọi đơn mới +
// đơn vừa sửa gần đây, vì Pancake luôn trả đơn mới nhất ở đầu danh sách (không sort lại theo update).
// Chạy 1 lần đầu với BACKFILL=1 để quét TOÀN BỘ lịch sử (paginate hết, dừng khi hết dữ liệu).

const SUPABASE_URL = 'https://bcrpxfvvjsjpvbksqzls.supabase.co';
const SESSION_TOKEN = process.env.PANCAKE_SESSION_TOKEN;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BACKFILL = process.env.BACKFILL === '1';
const PAGE_SIZE = 100;
const INCREMENTAL_MAX_PAGES = 5;
// User yêu cầu 11/9/2026: tạm thời chỉ lấy dữ liệu từ tháng 6/2026 trở đi (bỏ bớt phần T3-T5 đã backfill).
const MIN_ORDER_DATE = '2026-06-01';

// Map cứng shop -> brand (dò tay 11/9/2026 qua GET /shops). KHÔNG suy qua regex tên shop vì "Thời Đại"
// (tên shop Shidai) không chứa chữ "shidai" -- xem chi tiết trong supabase/datahub-schema.sql.
const SHOPS = [
  { id: 1022031789, brand: 'CT' },   // Chánh Tâm - Không Gian Tâm Linh Phật Giáo (847 đơn, chính)
  { id: 1943057093, brand: 'CT' },   // Đồ Thờ Nhập Khẩu Chánh Tâm
  { id: 100965386, brand: 'CT' },    // Đồ Thờ Chánh Tâm
  { id: 1021966905, brand: 'CT' },   // CHÁNH TÂM - Nội thất đồ thờ cao cấp
  { id: 1943096391, brand: 'HT' },   // Siêu thị Phật Giáo Hiền Thuỷ (387 đơn, chính)
  { id: 715061393, brand: 'HT' },    // Hiền Thuỷ - Siêu thị đồ thờ
  { id: 408077426, brand: 'HT' },    // Siêu thị Phật Giáo Hiền Thuỷ (trùng tên, hiện 0 đơn)
  { id: 1943052948, brand: 'Shidai' }, // Thời Đại - Tổng Kho Sỉ Đồ Thờ Miền Bắc (1618 đơn, chính)
  { id: 408040224, brand: 'TTV' },   // Nến Bơ - Tự Tại Viên (338 đơn, chính)
  { id: 1329071685, brand: 'Other' }, // Hoàng Dương | Ming Ying (6 đơn, nhỏ, không thuộc 4 brand chính)
];

async function fetchShopOrders(shopId) {
  let page = 1, all = [], totalPages = 1;
  while (page <= totalPages) {
    const url = `https://pos.pages.fm/api/v1/shops/${shopId}/orders?access_token=${SESSION_TOKEN}&page_size=${PAGE_SIZE}&page_number=${page}`;
    const res = await fetch(url);
    const json = await res.json();
    if (!json.success) throw new Error(`Pancake lỗi shop ${shopId} trang ${page}: ${json.message || JSON.stringify(json).slice(0, 200)}`);
    all = all.concat(json.data || []);
    totalPages = json.total_pages || 1;
    if (!BACKFILL && page >= INCREMENTAL_MAX_PAGES) break;
    // Pancake trả đơn mới nhất trước -- nếu trang này đã lùi quá MIN_ORDER_DATE thì dừng sớm, khỏi quét hết lịch sử.
    const oldestInPage = (json.data || []).length ? (json.data[json.data.length - 1].inserted_at || '').slice(0, 10) : null;
    if (oldestInPage && oldestInPage < MIN_ORDER_DATE) break;
    page++;
    await new Promise(r => setTimeout(r, 200)); // tránh dồn dập bị Pancake rate-limit
  }
  return all;
}

// LƯU Ý: endpoint list (page_size > 1, dùng cho sync hàng loạt) trả field KHÁC với endpoint xem 1 đơn lẻ --
// vd system_id -> display_id, account_name -> page.name, customer.tags -> customer.shop_customer.tags.
// Đã dò tay bằng cách so sánh response page_size=1 vs page_size=100 (11/9/2026), map theo đúng cấu trúc LIST.
function mapOrder(o, shopMeta) {
  const sc = (o.customer && o.customer.shop_customer) || {};
  const custStatus = (sc.order_count !== undefined ? sc.order_count : 1) <= 1 ? 'Mới' : 'Cũ';
  const tags = Array.isArray(sc.tags) ? sc.tags.join(', ') : null;
  const addr = o.shipping_address || {};
  const phone = (sc.phone_numbers && sc.phone_numbers[0]) || addr.phone_number || o.bill_phone_number || null;
  const pageName = o.page && o.page.name;
  const pageId = (o.page && o.page.id) || o.page_id;
  const sourceLabel = [o.ads_source, pageName ? `${pageName} (${pageId || ''})` : null].filter(Boolean).join(' / ') || null;
  return {
    shop_id: shopMeta.id,
    shop_name: pageName || null,
    brand: shopMeta.brand,
    order_id: o.id,
    system_id: o.display_id,
    order_date: (o.inserted_at || '').slice(0, 10),
    customer_status: custStatus,
    customer_tags: tags,
    customer_name: (o.customer && o.customer.name) || o.bill_full_name || null,
    phone,
    address: addr.address || addr.full_address || null,
    ward: addr.commune_name || null,
    district: addr.district_name || null,
    province: addr.province_name || null,
    source: sourceLabel,
    internal_note: o.note || null,
    staff_name: (o.creator && o.creator.name) || null,
    ad_id: o.ad_id || null,
    order_status: (o.status !== undefined && o.status !== null) ? String(o.status) : null,
    pancake_updated_at: o.updated_at || null,
  };
}

async function upsertOrders(rows) {
  if (!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/datahub_orders?on_conflict=shop_id,order_id`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase upsert lỗi ${res.status}: ${t.slice(0, 500)}`);
  }
}

async function logSync(shopMeta, status, created, errorMessage) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/datahub_sync_log`, {
      method: 'POST',
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: 'Bearer ' + SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shop_id: shopMeta.id, shop_name: shopMeta.brand, status,
        records_created: created || 0, finished_at: new Date().toISOString(),
        error_message: errorMessage || null,
      }),
    });
  } catch (e) { console.warn('Ghi sync_log lỗi (bỏ qua):', e.message); }
}

(async () => {
  if (!SESSION_TOKEN || !SERVICE_ROLE_KEY) {
    console.error('Thiếu PANCAKE_SESSION_TOKEN hoặc SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  console.log(`Chế độ: ${BACKFILL ? 'BACKFILL TOÀN BỘ LỊCH SỬ' : 'incremental (' + INCREMENTAL_MAX_PAGES + ' trang mới nhất/shop)'}`);
  let grandTotal = 0;
  const CHUNK = 500; // upsert theo lô, tránh 1 request quá lớn
  for (const shop of SHOPS) {
    try {
      const orders = await fetchShopOrders(shop.id);
      const rows = orders.filter(o => o.display_id).map(o => mapOrder(o, shop))
        .filter(r => r.order_date && r.order_date >= MIN_ORDER_DATE);
      for (let i = 0; i < rows.length; i += CHUNK) {
        await upsertOrders(rows.slice(i, i + CHUNK));
      }
      console.log(`Shop ${shop.id} (${shop.brand}): ${rows.length} đơn đã upsert.`);
      grandTotal += rows.length;
      await logSync(shop, 'success', rows.length, null);
    } catch (e) {
      console.error(`Shop ${shop.id} (${shop.brand}) LỖI: ${e.message}`);
      await logSync(shop, 'failed', 0, e.message);
    }
  }
  console.log(`XONG. Tổng ${grandTotal} đơn đã đồng bộ.`);
})();
