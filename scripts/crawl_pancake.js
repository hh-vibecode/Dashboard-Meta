const TOK = process.env.TOK;
const FROM = '2026-08-22', TO = '2026-08-24';
const fs = require('fs');

const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function get(url, tries=3){
  for(let i=0;i<tries;i++){
    try{
      const res = await fetch(url);
      if(res.ok) return await res.json();
      if(res.status===429){ await sleep(2000*(i+1)); continue; }
      return null;
    }catch(e){ await sleep(1000); }
  }
  return null;
}

(async()=>{
  const pagesRes = await get(`https://pancake.vn/api/v1/pages?access_token=${TOK}`);
  const pages = (pagesRes.categorized?.activated)||[];
  console.log('pages:', pages.length);

  const out = [];
  for(const p of pages){
    // users -> map uid to sale name
    const ures = await get(`https://pancake.vn/api/v1/pages/${p.id}/users?access_token=${TOK}`);
    const userMap = {};
    (ures?.users||[]).forEach(u=>userMap[u.id]=u.name);

    let count = 0, batch = 0, stop = false, convsInRange = [];
    while(!stop && batch < 40){
      const url = `https://pancake.vn/api/v1/pages/${p.id}/conversations?access_token=${TOK}${count?`&current_count=${count}`:''}`;
      const d = await get(url);
      const convs = d?.conversations||[];
      if(!convs.length) break;
      for(const c of convs){
        const up = (c.updated_at||'').slice(0,10);
        if(up >= FROM && up <= TO) convsInRange.push(c);
        else if(up < FROM) stop = true; // sorted desc by updated_at
      }
      count += convs.length;
      batch++;
      await sleep(150);
    }
    console.log(`${p.name}: ${convsInRange.length} hội thoại trong ${FROM}..${TO} (quét ${count})`);

    for(const c of convsInRange){
      const custId = c.customers?.[0]?.id;
      if(!custId) continue;
      const m = await get(`https://pancake.vn/api/v1/pages/${p.id}/conversations/${c.id}/messages?customer_id=${custId}&access_token=${TOK}`);
      const msgs = (m?.messages||[]).map(x=>({
        at: x.inserted_at,
        from_page: x.from?.id === p.id,
        admin: x.from?.admin_name || null,
        from_name: x.from?.name || null,
        text: (x.message||x.snippet||'').toString(),
        has_attach: (x.attachments||[]).length>0
      })).sort((a,b)=> (a.at||'').localeCompare(b.at||''));
      out.push({
        page_id: p.id, page_name: p.name,
        conv_id: c.id, type: c.type,
        // fb_id là KHOÁ NỐI giữa hội thoại COMMENT và INBOX của CÙNG một người:
        // conv INBOX có id = `{page_id}_{fb_id}`, còn conv COMMENT mang fb_id trong customers[0].
        // Thiếu nó thì bình luận được điều hướng sang inbox sẽ bị chấm oan là "không trả lời".
        customer_id: custId,
        fb_id: c.customers?.[0]?.fb_id || null,
        from_psid: c.from_psid || null,
        customer: c.customers?.[0]?.name || c.from?.name || '',
        phone: (c.recent_phone_numbers||[]).map(x=>x.phone_number)[0] || null,
        assignees: (c.assignee_ids||[]).map(id=>userMap[id]||id),
        message_count: c.message_count,
        updated_at: c.updated_at,
        tags: c.tags,
        messages: msgs
      });
      await sleep(120);
    }
  }
  fs.writeFileSync('pancake_sample_22_24.json', JSON.stringify(out,null,1));
  console.log('TOTAL conversations saved:', out.length);
  console.log('total messages:', out.reduce((s,c)=>s+c.messages.length,0));
})();
