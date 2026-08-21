const Papa = require('papaparse');
const { Client } = require('pg');

const MKT_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTOAVLKJ1Ng0K31WStnYl4UjzRH3qbVEuh-Y7wdXDGBR5mTpFF6X3cTq8se3LAafqosie7AiqT5kkSO/pub?gid=2103164095&single=true&output=csv';
const SAONL_MASTER_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQraTrk4Ha7Sy6G3FwCUlubRbGtKQ4lkqHHDLimn3rmC29DmxFzpV5Ny7Ed57KgSBl3_BTXUj4HahIb/pub?gid=1474031151&single=true&output=csv';
const SAONL_CRM_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQraTrk4Ha7Sy6G3FwCUlubRbGtKQ4lkqHHDLimn3rmC29DmxFzpV5Ny7Ed57KgSBl3_BTXUj4HahIb/pub?gid=768026359&single=true&output=csv';

// ---- ported straight from index.html so migration matches what the live dashboard parses ----
function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
  const vn = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (vn) return new Date(+vn[3], +vn[2] - 1, +vn[1]);
  return null;
}
function toISODate(d) { if (!d) return null; return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  let s = String(v).trim();
  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  if (dots > 0 && commas > 0) {
    if (s.indexOf(',') > s.indexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (commas > 1) { s = s.replace(/,/g, ''); }
  else if (commas === 1) { s = s.replace(',', '.'); }
  else if (dots > 1) { s = s.replace(/\./g, ''); }
  const n = parseFloat(s.replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? 0 : n;
}
function vndNum(v) { const n = parseInt(String(v == null ? '' : v).replace(/[^0-9-]/g, ''), 10); return isNaN(n) ? 0 : n; }
function detectBrand(name) {
  const n = (name || '').trim();
  if (/tự tại viên|tu tai vien|nến bơ|nen bo/i.test(n)) return 'TTV';
  if (/^HT[\s\-–]|^HT$|hiền thu[ỷy]|hiến thu[ỷy]|hien thuy/i.test(n)) return 'HT';
  if (/shidai/i.test(n)) return 'Shidai';
  if (/chánh tâm|chanh tam|^CT[\s\-–]/i.test(n)) return 'CT';
  return 'CT';
}
function detectProduct(name) {
  const n = (name || '').toLowerCase();
  if (/thần tài|ban thần tài|tài địa|di lặc|quan lộc/.test(n)) return 'Thần Tài';
  if (/tượng phật/.test(n)) return 'Tượng Phật';
  if (/đèn thờ|đèn/.test(n)) return 'Đèn Thờ';
  if (/ban thờ|bàn thờ|đồ thờ/.test(n)) return 'Ban Thờ';
  if (/dịch vụ/.test(n)) return 'Dịch Vụ';
  const cleaned = (name || '').trim().replace(/^(HT|Shidai)\s*[-–]\s*/i, '').replace(/\s*[-–]\s*(fix bài cũ|mess tiềm năng|mess mua hàng).*$/i, '').replace(/\s*[-–]\s*\d{2}\/\d{2}.*/, '').trim();
  return cleaned || 'Khác';
}

async function fetchCsv(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed ${res.status} for ${url}`);
  return res.text();
}

function parseMktCsv(text) {
  const parsed = Papa.parse(text, { skipEmptyLines: true });
  const headers = (parsed.data[0] || []).map(h => String(h).trim().toLowerCase());
  function ci(kws, fb) { for (const kw of kws) { const i = headers.findIndex(h => h.includes(kw)); if (i >= 0) return i; } return fb; }
  const COL = {};
  COL.CAMPAIGN = ci(['tên chiến dịch', 'campaign name'], 0);
  COL.AD_ID = ci(['mã quảng cáo', 'ad id'], 1);
  COL.DATE = ci(['ngày bắt đầu', 'reporting starts', 'ngày'], 2);
  COL.REACH = ci(['người tiếp cận', 'phạm vi tiếp cận', 'reach'], 4);
  COL.IMPRESSIONS = ci(['lượt hiển thị', 'impressions'], 5);
  COL.SPEND = ci(['số tiền đã chi', 'amount spent', 'chi phí', 'chi tiêu'], 8);
  COL.MESSAGES = headers.findIndex(h => (h.includes('lượt bắt đầu cuộc trò chuyện') || h.includes('conversations started') || h.includes('messaging conversations started')) && !h.startsWith('chi'));
  if (COL.MESSAGES < 0) COL.MESSAGES = 12;
  COL.CTR = ci(['ctr'], 11);
  COL.CPC = ci(['cpc'], 12);
  COL.COMMENTS = ci(['bình luận', 'comment'], 13);
  COL.ADSET_NAME = ci(['tên nhóm quảng cáo', 'ad set name', 'tên nhóm'], -1);
  COL.AD_NAME = ci(['tên quảng cáo', 'ad name'], -1);
  console.log('[MKT] COL:', JSON.stringify(COL));

  const allData = parsed.data.slice(1).filter(row => row.some(c => c !== ''));
  let lastCamp = '', lastAdSet = '', lastAdName = '', lastDate = '';
  allData.forEach(row => {
    const dv = (row[COL.DATE] || '').trim();
    if (dv && dv.toLowerCase() !== 'all') lastDate = dv; else if (!dv) row[COL.DATE] = lastDate;
    const camp = (row[COL.CAMPAIGN] || '').trim();
    if (camp && camp.toLowerCase() !== 'all') { lastCamp = camp; lastAdSet = ''; lastAdName = ''; } else if (!camp) row[COL.CAMPAIGN] = lastCamp;
    if (COL.ADSET_NAME >= 0) {
      const as = (row[COL.ADSET_NAME] || '').trim();
      if (as && as.toLowerCase() !== 'all') { lastAdSet = as; lastAdName = ''; } else if (!as) row[COL.ADSET_NAME] = lastAdSet;
    }
    if (COL.AD_NAME >= 0) {
      const an = (row[COL.AD_NAME] || '').trim();
      if (an && an.toLowerCase() !== 'all') lastAdName = an; else if (!an) row[COL.AD_NAME] = lastAdName;
    }
  });
  const adCampCount = {};
  allData.forEach(row => {
    const adId = String(row[COL.AD_ID] || '').trim();
    if (!/^\d{8,}$/.test(adId)) return;
    const camp = (row[COL.CAMPAIGN] || '').trim();
    if (!camp) return;
    (adCampCount[adId] = adCampCount[adId] || {})[camp] = (adCampCount[adId][camp] || 0) + 1;
  });
  const adDominantCamp = {};
  Object.entries(adCampCount).forEach(([adId, counts]) => {
    let best = '', bestN = 0;
    Object.entries(counts).forEach(([camp, n]) => { if (n > bestN) { best = camp; bestN = n; } });
    if (best) adDominantCamp[adId] = best;
  });
  allData.forEach(row => {
    const adId = String(row[COL.AD_ID] || '').trim();
    if (!/^\d{8,}$/.test(adId)) return;
    const dom = adDominantCamp[adId];
    if (dom && (row[COL.CAMPAIGN] || '').trim() !== dom) row[COL.CAMPAIGN] = dom;
  });
  const CAMPAIGN_ALIASES = { 'Hiền Thuỷ - Thần Tài 12/06': 'Hiền Thuỷ - Chung 12/06' };
  allData.forEach(row => { const camp = (row[COL.CAMPAIGN] || '').trim(); if (CAMPAIGN_ALIASES[camp]) row[COL.CAMPAIGN] = CAMPAIGN_ALIASES[camp]; });

  // Ad-level rows only (specific numeric Ad ID) -- this is what we store, one row per ad per day
  const adRows = allData.filter(row => {
    const adId = String(row[COL.AD_ID] || '').trim();
    if (!/^\d{8,}$/.test(adId)) return false;
    const d = parseDate((row[COL.DATE] || '').trim());
    return d !== null;
  });
  console.log('[MKT] total rows:', allData.length, '/ ad-level rows:', adRows.length);
  return adRows.map(row => {
    const camp = (row[COL.CAMPAIGN] || '').trim();
    return {
      ad_id: String(row[COL.AD_ID]).trim(),
      ad_date: toISODate(parseDate(row[COL.DATE])),
      campaign_name: camp,
      adset_name: COL.ADSET_NAME >= 0 ? (row[COL.ADSET_NAME] || '').trim() || null : null,
      ad_name: COL.AD_NAME >= 0 ? (row[COL.AD_NAME] || '').trim() || null : null,
      brand: detectBrand(camp),
      product: detectProduct(camp),
      reach: Math.round(toNum(row[COL.REACH])),
      impressions: Math.round(toNum(row[COL.IMPRESSIONS])),
      spend: toNum(row[COL.SPEND]),
      messages: Math.round(toNum(row[COL.MESSAGES])),
      ctr: toNum(row[COL.CTR]),
      cpc: toNum(row[COL.CPC]),
      comments: Math.round(toNum(row[COL.COMMENTS])),
    };
  });
}

function saonlCi(headers) {
  return (kws, fb) => {
    for (const kw of kws) { const i = headers.findIndex(h => h === kw); if (i >= 0) return i; }
    for (const kw of kws) { const i = headers.findIndex(h => h.includes(kw)); if (i >= 0) return i; }
    return fb;
  };
}

function parseSaonlMaster(text) {
  const parsed = Papa.parse(text, { skipEmptyLines: true });
  const headers = (parsed.data[0] || []).map(h => String(h).trim().toLowerCase());
  const ci = saonlCi(headers);
  const c = {
    DATE: ci(['ngày tạo'], 1), SOURCE: ci(['nguồn khách', 'nguồn'], 2), CHANNEL: ci(['kênh'], 3),
    SALES: ci(['sales phụ trách'], 4), AD_ID: ci(['ad id', 'mã quảng cáo'], 5), LEAD_ID: ci(['lead id'], 6),
    NAME: ci(['họ tên khách', 'họ tên'], 7), PHONE: ci(['sđt', 'số điện thoại'], 8), CITY: ci(['tỉnh/tp', 'tỉnh'], 9),
    DISTRICT: ci(['quận/huyện', 'quận'], 10), ADDRESS: ci(['địa chỉ'], 11), STATUS: ci(['phân loại kh'], 12),
    PRODUCT: ci(['nhu cầu ban đầu', 'nhu cầu'], 13), LAST_CS: ci(['ngày chăm sóc cuối'], 14),
    TOTAL_REV: ci(['giá trị đơn cộng dồn'], 15), MA_KH: ci(['mã kh'], 16), GROUP: ci(['nhóm kh'], 17),
  };
  const rows = parsed.data.slice(1).filter(row => row.some(x => x !== ''));
  console.log('[SAONL-MASTER] COL:', JSON.stringify(c), 'rows:', rows.length);
  // dedupe by lead_id (PK) -- keep last occurrence, warn if collisions found
  const byId = new Map();
  let blankId = 0, dupes = 0;
  rows.forEach(m => {
    const leadId = (m[c.LEAD_ID] || '').toString().trim();
    if (!leadId) { blankId++; return; }
    if (byId.has(leadId)) dupes++;
    byId.set(leadId, {
      lead_id: leadId,
      created_date: toISODate(parseDate(m[c.DATE])),
      source: (m[c.SOURCE] || '').trim() || null,
      channel: (m[c.CHANNEL] || '').trim() || null,
      sales_rep: (m[c.SALES] || '').trim() || null,
      ad_id: (m[c.AD_ID] || '').trim() || null,
      name: (m[c.NAME] || '').trim() || '(chưa có tên)',
      phone: (m[c.PHONE] || '').trim() || null,
      city: (m[c.CITY] || '').trim() || null,
      district: (m[c.DISTRICT] || '').trim() || null,
      address: (m[c.ADDRESS] || '').trim() || null,
      status: (m[c.STATUS] || '').trim() || null,
      product_need: (m[c.PRODUCT] || '').trim() || null,
      ma_kh: (m[c.MA_KH] || '').trim() || null,
      customer_group: (m[c.GROUP] || '').trim() || null,
    });
  });
  console.log('[SAONL-MASTER] blank lead_id skipped:', blankId, '/ duplicate lead_id (kept last):', dupes);
  return [...byId.values()];
}

function parseSaonlCrm(text) {
  const parsed = Papa.parse(text, { skipEmptyLines: true });
  const headers = (parsed.data[0] || []).map(h => String(h).trim().toLowerCase());
  const ci = saonlCi(headers);
  const c = {
    DATE: ci(['ngày chăm sóc'], 0), LEAD_ID: ci(['lead id'], 1), SOURCE: ci(['nguồn khách', 'nguồn'], 2),
    CHANNEL: ci(['kênh'], 3), SALES: ci(['sales phụ trách'], 4), AD_ID: ci(['ad id', 'mã quảng cáo'], 5),
    NAME: ci(['họ tên khách', 'họ tên'], 6), PHONE: ci(['sđt', 'số điện thoại'], 7), STATUS_KH: ci(['phân loại kh'], 8),
    FORM: ci(['hình thức chăm sóc', 'hình thức'], 9), CONTENT: ci(['nội dung trao đổi', 'nội dung'], 10),
    EXPECTED: ci(['giá trị tiềm năng'], 11), STATUS: ci(['trạng thái'], 12),
    LOST_GROUP: ci(['nhóm nguyên nhân mất lead', 'nhóm nguyên nhân'], 13), LOST_REASON: ci(['nguyên nhân cụ thể'], 14),
    CLOSE_DATE: ci(['ngày chốt'], 15), CLOSE_VALUE: ci(['doanh thu'], 16),
  };
  const rows = parsed.data.slice(1).filter(row => row.some(x => x !== ''));
  console.log('[SAONL-CRM] COL:', JSON.stringify(c), 'rows:', rows.length);
  return rows;
}

// map free-text trạng thái (lịch sử) -> 4 giá trị cố định của schema mới
function normStatus(v) {
  const s = (v || '').trim().toLowerCase();
  if (!s) return null;
  if (/^mất\s*lead$/i.test(s.replace(/\s+/g, ' '))) return 'Mất lead';
  if (/chốt\s*đơn/.test(s)) return 'Chốt đơn';
  if (/dài\s*hạn/.test(s)) return 'Chăm sóc dài hạn';
  if (/đang\s*chăm\s*sóc/.test(s)) return 'Đang chăm sóc';
  return null; // giá trị lạ -- để null thay vì bịa, giữ nguyên gốc ở status_kh nếu cần tra lại
}

async function batchInsert(client, table, rows, cols, conflictCols, chunkSize = 500) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const placeholders = chunk.map((row, ri) => {
      const base = ri * cols.length;
      values.push(...cols.map(c => row[c] === undefined ? null : row[c]));
      return '(' + cols.map((_, ci) => `$${base + ci + 1}`).join(',') + ')';
    }).join(',');
    const conflictClause = conflictCols
      ? `on conflict (${conflictCols.join(',')}) do update set ${cols.filter(c => !conflictCols.includes(c)).map(c => `${c}=excluded.${c}`).join(',')}`
      : '';
    const sql = `insert into ${table} (${cols.join(',')}) values ${placeholders} ${conflictClause}`;
    await client.query(sql, values);
    inserted += chunk.length;
    console.log(`[${table}] inserted ${inserted}/${rows.length}`);
  }
}

(async () => {
  const password = process.env.SB_DB_PASSWORD;
  const ref = 'bcrpxfvvjsjpvbksqzls';
  const client = new Client({
    host: 'aws-0-ap-southeast-1.pooler.supabase.com', port: 6543,
    user: `postgres.${ref}`, password, database: 'postgres',
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000,
  });
  await client.connect();
  console.log('[connected]');

  console.log('\n=== MKT ===');
  const mktText = await fetchCsv(MKT_URL);
  const mktRows = parseMktCsv(mktText);
  await batchInsert(client, 'mkt_spend', mktRows,
    ['ad_id', 'ad_date', 'campaign_name', 'adset_name', 'ad_name', 'brand', 'product', 'reach', 'impressions', 'spend', 'messages', 'ctr', 'cpc', 'comments'],
    ['ad_id', 'ad_date']);

  console.log('\n=== Sale Online Master ===');
  const masterText = await fetchCsv(SAONL_MASTER_URL);
  const masterRows = parseSaonlMaster(masterText);
  await batchInsert(client, 'saonl_customers', masterRows,
    ['lead_id', 'created_date', 'source', 'channel', 'sales_rep', 'ad_id', 'name', 'phone', 'city', 'district', 'address', 'status', 'product_need', 'ma_kh', 'customer_group'],
    ['lead_id']);

  console.log('\n=== Sale Online CRM ===');
  const crmText = await fetchCsv(SAONL_CRM_URL);
  const crmRawRows = parseSaonlCrm(crmText);
  const cc = (() => {
    const parsed = Papa.parse(crmText, { skipEmptyLines: true });
    const headers = (parsed.data[0] || []).map(h => String(h).trim().toLowerCase());
    const ci = saonlCi(headers);
    return {
      DATE: ci(['ngày chăm sóc'], 0), LEAD_ID: ci(['lead id'], 1), SOURCE: ci(['nguồn khách', 'nguồn'], 2),
      CHANNEL: ci(['kênh'], 3), SALES: ci(['sales phụ trách'], 4), AD_ID: ci(['ad id', 'mã quảng cáo'], 5),
      STATUS_KH: ci(['phân loại kh'], 8), FORM: ci(['hình thức chăm sóc', 'hình thức'], 9),
      CONTENT: ci(['nội dung trao đổi', 'nội dung'], 10), EXPECTED: ci(['giá trị tiềm năng'], 11),
      STATUS: ci(['trạng thái'], 12), LOST_GROUP: ci(['nhóm nguyên nhân mất lead', 'nhóm nguyên nhân'], 13),
      LOST_REASON: ci(['nguyên nhân cụ thể'], 14), CLOSE_DATE: ci(['ngày chốt'], 15), CLOSE_VALUE: ci(['doanh thu'], 16),
    };
  })();

  const knownLeadIds = new Set(masterRows.map(m => m.lead_id));
  let orphanCare = 0, unmappedStatus = new Set();
  const careRows = crmRawRows.map(r => {
    const leadId = (r[cc.LEAD_ID] || '').toString().replace(/[\t\n\r]/g, ' ').trim();
    if (!leadId || !knownLeadIds.has(leadId)) { orphanCare++; return null; }
    const rawStatus = (r[cc.STATUS] || '').trim();
    const status = normStatus(rawStatus);
    if (rawStatus && !status) unmappedStatus.add(rawStatus);
    return {
      customer_id: leadId,
      care_date: toISODate(parseDate(r[cc.DATE])) || toISODate(new Date()),
      source: (r[cc.SOURCE] || '').trim() || null,
      channel: (r[cc.CHANNEL] || '').trim() || null,
      sales_rep: (r[cc.SALES] || '').trim() || null,
      ad_id: (r[cc.AD_ID] || '').trim() || null,
      status_kh: (r[cc.STATUS_KH] || '').trim() || null,
      care_form: (r[cc.FORM] || '').trim() || null,
      content: (r[cc.CONTENT] || '').trim() || null,
      expected_value: vndNum(r[cc.EXPECTED]) || null,
      status,
      lost_group: (r[cc.LOST_GROUP] || '').trim() || null,
      lost_reason: (r[cc.LOST_REASON] || '').trim() || null,
      close_date: toISODate(parseDate(r[cc.CLOSE_DATE])),
      close_value: vndNum(r[cc.CLOSE_VALUE]) || null,
    };
  }).filter(Boolean);
  console.log('[SAONL-CRM] usable rows:', careRows.length, '/ orphan (lead_id not in master, skipped):', orphanCare);
  if (unmappedStatus.size) console.log('[SAONL-CRM] status values not mapped to 4 fixed values (left null):', [...unmappedStatus]);

  await batchInsert(client, 'saonl_care_log', careRows,
    ['customer_id', 'care_date', 'source', 'channel', 'sales_rep', 'ad_id', 'status_kh', 'care_form', 'content', 'expected_value', 'status', 'lost_group', 'lost_reason', 'close_date', 'close_value'],
    null);

  console.log('\n=== Sales reps roster (từ giá trị sales_rep xuất hiện trong Master+CRM) ===');
  const repNames = new Set();
  masterRows.forEach(m => { if (m.sales_rep) repNames.add(m.sales_rep); });
  careRows.forEach(c => { if (c.sales_rep) repNames.add(c.sales_rep); });
  const repRows = [...repNames].map(name => ({ name, active: true }));
  await batchInsert(client, 'saonl_sales_reps', repRows, ['name', 'active'], ['name']);
  console.log('[saonl_sales_reps] distinct names loaded:', repRows.length, '-- ĐÂY LÀ DANH SÁCH THÔ, user cần tự rà lại active=true/false cho đúng nhân sự hiện tại');

  const summary = await client.query(`
    select 'mkt_spend' t, count(*) n from mkt_spend
    union all select 'saonl_customers', count(*) from saonl_customers
    union all select 'saonl_care_log', count(*) from saonl_care_log
    union all select 'saonl_sales_reps', count(*) from saonl_sales_reps
  `);
  console.log('\n=== FINAL COUNTS ===');
  summary.rows.forEach(r => console.log(r.t, ':', r.n));

  await client.end();
})().catch(e => { console.error('MIGRATION_ERROR', e); process.exit(1); });
