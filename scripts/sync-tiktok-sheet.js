#!/usr/bin/env node
/**
 * Nạp số liệu TikTok (Chánh Tâm) từ Google Sheet công bố -> Supabase social_page_stats (platform='tiktok').
 * Chạy: SUPABASE_SERVICE_ROLE_KEY=... node scripts/sync-tiktok-sheet.js
 * Tạm dùng sheet thủ công; khi có TikTok API thì thay hàm fetch bên dưới, phần gộp/ghi giữ nguyên.
 *
 * Sheet có 4 tab; script chỉ dùng 2 tab:
 *  - TỔNG QUAN (gid 1887252839): Ngày | Lượt xem video | Lượt xem hồ sơ | Lượt thích | Bình luận | Lượt chia sẻ
 *    (có dòng phân cách "THÁNG 7"/"THÁNG 8" xen giữa -> dùng để biết ngày d/m thuộc tháng nào)
 *  - FOLLOW THEO NGÀY (gid 354827379): Ngày ("1 tháng Bảy") | Tổng follow | Tăng/giảm
 */
const SHEET='2PACX-1vT-PzzeMM_dJksKNekr4OeY8eKYxexsRB32-EG7jWzuLNlsX52sXL40AIkWELmZ1t0-Uuhs9w8aXlJz';
const GID_TONG='1887252839', GID_FOLLOW='354827379';
const PAGE_ID='tiktok_chanhtam', PAGE_NAME='Chánh Tâm (TikTok)', BRAND='CT', YEAR=2026;
const SB_URL='https://bcrpxfvvjsjpvbksqzls.supabase.co';
const SB_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;

const csvUrl=g=>`https://docs.google.com/spreadsheets/d/e/${SHEET}/pub?gid=${g}&single=true&output=csv&cachebust=${Date.now()}`;
const MONTHS={'một':1,'hai':2,'ba':3,'tư':4,'năm':5,'sáu':6,'bảy':7,'tám':8,'chín':9,'mười':10,'mười một':11,'mười hai':12};
const N=v=>{const n=parseInt(String(v??'').replace(/[^\d-]/g,''),10);return isNaN(n)?0:n;};

function parseCsv(t){
  const rows=[];let row=[],cell='',q=false;
  for(let i=0;i<t.length;i++){const c=t[i];
    if(q){ if(c==='"'){ if(t[i+1]==='"'){cell+='"';i++;} else q=false; } else cell+=c; }
    else if(c==='"')q=true;
    else if(c===','){row.push(cell);cell='';}
    else if(c==='\n'){row.push(cell);rows.push(row);row=[];cell='';}
    else if(c!=='\r')cell+=c;
  }
  if(cell||row.length){row.push(cell);rows.push(row);}
  return rows;
}
async function getCsv(g){const r=await fetch(csvUrl(g));if(!r.ok)throw new Error(`Sheet gid=${g} lỗi ${r.status}`);return parseCsv(await r.text());}

(async()=>{
  if(!SB_KEY) throw new Error('Thiếu SUPABASE_SERVICE_ROLE_KEY');
  // ── tab TỔNG QUAN: gộp theo tháng ──
  const byMonth={};
  let curM=null;
  for(const r of await getCsv(GID_TONG)){
    const a=(r[0]||'').trim();
    const mHead=a.match(/^TH[ÁA]NG\s+(\d{1,2})/i);
    if(mHead){curM=+mHead[1];continue;}
    const md=a.match(/^(\d{1,2})\/(\d{1,2})$/);
    if(!md)continue;
    const m=+md[2]||curM; if(!m)continue;
    const k=`${YEAR}-${String(m).padStart(2,'0')}-01`;
    const o=byMonth[k]||(byMonth[k]={video_views:0,profile_visits:0,reactions:0,comments:0,shares:0,days:0});
    o.video_views+=N(r[1]); o.profile_visits+=N(r[2]);
    o.reactions+=N(r[3]);   o.comments+=N(r[4]); o.shares+=N(r[5]);
    o.days++;
  }
  // ── tab FOLLOW: tổng follow cuối tháng + tăng trong tháng ──
  const fol={};
  for(const r of await getCsv(GID_FOLLOW)){
    const a=(r[0]||'').trim().toLowerCase();
    const md=a.match(/^(\d{1,2})\s*th[áa]ng\s+(.+)$/);
    if(!md)continue;
    const m=MONTHS[md[2].trim()]; if(!m)continue;
    const k=`${YEAR}-${String(m).padStart(2,'0')}-01`;
    const o=fol[k]||(fol[k]={last:0,add:0,day:0});
    const d=+md[1];
    if(d>=o.day){o.day=d;o.last=N(r[1]);}
    o.add+=N(r[2]);
  }
  const rows=Object.entries(byMonth).map(([month,o])=>({
    stat_month:month, platform:'tiktok', page_id:PAGE_ID, page_name:PAGE_NAME, brand:BRAND,
    followers_total: fol[month]?.last ?? null,
    followers_new: fol[month]?.add ?? null,
    followers_lost: null,
    impressions: o.video_views,          // TikTok: lượt xem video ~ "hiển thị"
    profile_visits: o.profile_visits,
    reactions:o.reactions, comments:o.comments, shares:o.shares,
    video_views:o.video_views,
    engagements_total:o.reactions+o.comments+o.shares,
    posts_count:null, reach:null, reach_organic:null, reach_paid:null,
    link_clicks:null, new_conversations:null,
  }));
  rows.forEach(r=>console.log(`  ✅ ${r.stat_month.slice(0,7)}: ${r.followers_total} follow (+${r.followers_new}), ${r.video_views.toLocaleString()} view, ${r.engagements_total.toLocaleString()} tương tác`));

  const res=await fetch(`${SB_URL}/rest/v1/social_page_stats?on_conflict=stat_month,page_id`,{
    method:'POST',
    headers:{apikey:SB_KEY,Authorization:'Bearer '+SB_KEY,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates'},
    body:JSON.stringify(rows)});
  if(!res.ok)throw new Error(`Supabase lỗi ${res.status}: ${(await res.text()).slice(0,300)}`);
  console.log(`Đã ghi ${rows.length} dòng TikTok.`);
})().catch(e=>{console.error('SYNC_ERROR:',e.message);process.exit(1);});
