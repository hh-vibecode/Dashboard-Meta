#!/usr/bin/env node
/**
 * Đồng bộ số liệu Page Facebook -> Supabase (bảng social_page_stats), chốt theo THÁNG.
 * Chạy:  META_PAGE_TOKEN=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/sync-social-pages.js [YYYY-MM]
 * Không truyền tháng thì mặc định lấy THÁNG TRƯỚC (dùng cho job chạy ngày đầu tháng).
 *
 * Lưu ý về metric (đã dò thực tế trên API v21, 8/2026):
 *  - page_impressions / page_impressions_unique (reach) ĐÃ BỊ META BỎ -> không lấy được reach tự nhiên.
 *    Phần trả phí lấy từ bảng mkt_spend (Meta Ads API) nếu cần đối chiếu.
 *  - page_fans bỏ -> dùng followers_count trên chính object Page.
 */
const API = 'https://graph.facebook.com/v21.0';
const TOKEN = process.env.META_PAGE_TOKEN;
const SB_URL = 'https://bcrpxfvvjsjpvbksqzls.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 4 page chính (id -> thương hiệu). Thêm page mới thì thêm 1 dòng ở đây.
const PAGES = {
  '107224335550589': 'CT',      // Chánh Tâm - Không Gian Tâm Linh Phật Giáo
  '105133802417722': 'HT',      // Siêu Thị Phật Giáo Hiền Thuỷ
  '100667699549693': 'TTV',     // Nến Bơ - Tự Tại Viên
  '506247572578559': 'Shidai',  // Thời Đại - Tổng Kho Sỉ Đồ Thờ Miền Bắc
};

function monthRange(ym){
  const [y,m] = ym.split('-').map(Number);
  const since = new Date(Date.UTC(y, m-1, 1));
  const until = new Date(Date.UTC(y, m, 1));
  const f = d => d.toISOString().slice(0,10);
  return { since: f(since), until: f(until), month: `${ym}-01` };
}
function defaultMonth(){
  const n = new Date(); const y = n.getFullYear(), m = n.getMonth(); // tháng trước
  const d = new Date(Date.UTC(y, m-1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
}
async function getJson(url){
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error(`${j.error.message} (code ${j.error.code})`);
  return j;
}
async function insight(pageId, token, metric, since, until){
  try{
    const j = await getJson(`${API}/${pageId}/insights?metric=${metric}&period=day&since=${since}&until=${until}&access_token=${token}`);
    const vals = j.data?.[0]?.values || [];
    return { sum: vals.reduce((s,v)=>s+(typeof v.value==='number'?v.value:0),0),
             last: vals.length ? vals[vals.length-1].value : null };
  }catch(e){ return { sum:null, last:null, err:e.message }; }
}

(async ()=>{
  if(!TOKEN) throw new Error('Thiếu META_PAGE_TOKEN');
  if(!SB_KEY) throw new Error('Thiếu SUPABASE_SERVICE_ROLE_KEY');
  const ym = process.argv[2] || defaultMonth();
  const { since, until, month } = monthRange(ym);
  console.log(`Đồng bộ số liệu Page tháng ${ym} (${since} -> ${until})`);

  const accounts = await getJson(`${API}/me/accounts?fields=id,name,access_token,followers_count&limit=100&access_token=${TOKEN}`);
  const rows = [];
  for (const acc of accounts.data.filter(a=>PAGES[a.id])){
    const t = acc.access_token;
    const [follows, newF, lostF, eng, views, vidAll, vidOrg, vidPaid, impOrg] = await Promise.all([
      insight(acc.id,t,'page_follows',since,until),
      insight(acc.id,t,'page_daily_follows',since,until),
      insight(acc.id,t,'page_daily_unfollows',since,until),
      insight(acc.id,t,'page_post_engagements',since,until),
      insight(acc.id,t,'page_views_total',since,until),
      insight(acc.id,t,'page_video_views',since,until),
      insight(acc.id,t,'page_video_views_organic',since,until),
      insight(acc.id,t,'page_video_views_paid',since,until),
      insight(acc.id,t,'page_posts_impressions_organic',since,until),
    ]);
    // tương tác chi tiết: đếm từ chính các bài đăng trong tháng
    let posts=0, reactions=0, comments=0, shares=0;
    try{
      let url=`${API}/${acc.id}/posts?fields=id,reactions.summary(true).limit(0),comments.summary(true).limit(0),shares&since=${since}&until=${until}&limit=100&access_token=${t}`;
      while(url){
        const j = await getJson(url);
        for(const p of j.data||[]){
          posts++;
          reactions += p.reactions?.summary?.total_count || 0;
          comments  += p.comments?.summary?.total_count  || 0;
          shares    += p.shares?.count || 0;
        }
        url = j.paging?.next || null;
      }
    }catch(e){ console.log(`  ⚠️ ${acc.name}: không đọc được bài đăng (${e.message})`); }

    rows.push({
      stat_month: month, page_id: acc.id, page_name: acc.name, brand: PAGES[acc.id],
      followers_total: follows.last ?? acc.followers_count ?? null,
      followers_new: newF.sum, followers_lost: lostF.sum,
      reach: null,                        // Meta đã bỏ metric reach cấp Page
      reach_organic: null, reach_paid: null,
      impressions: impOrg.sum,            // hiển thị bài viết (tự nhiên)
      profile_visits: views.sum,
      reactions, comments, shares,
      link_clicks: null,
      video_views: vidAll.sum,
      posts_count: posts,
      new_conversations: null,            // lấy từ Pancake nếu cần
      engagements_total: eng.sum,
      video_views_organic: vidOrg.sum, video_views_paid: vidPaid.sum,
    });
    console.log(`  ✅ ${acc.name}: ${follows.last} follower (+${newF.sum}/-${lostF.sum}), ${posts} bài, ${reactions} cảm xúc`);
  }

  const res = await fetch(`${SB_URL}/rest/v1/social_page_stats?on_conflict=stat_month,page_id`,{
    method:'POST',
    headers:{apikey:SB_KEY,Authorization:'Bearer '+SB_KEY,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates'},
    body: JSON.stringify(rows)
  });
  if(!res.ok) throw new Error(`Supabase lỗi ${res.status}: ${(await res.text()).slice(0,300)}`);
  console.log(`Đã ghi ${rows.length} dòng vào social_page_stats.`);
})().catch(e=>{ console.error('SYNC_ERROR:', e.message); process.exit(1); });
