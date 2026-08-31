import json, re, html
d = json.load(open('pancake_sample_22_24.json'))

def clean(t):
    if not t: return ''
    t = re.sub(r"<Copy[^>]*text='([^']*)'[^>]*>.*?</Copy>", r'\1', t, flags=re.S)
    t = re.sub(r'<br[^>]*/?>', ' ', t)
    t = re.sub(r"<a href='([^']*)'[^>]*>.*?</a>", r'\1', t, flags=re.S)
    t = re.sub(r'<[^>]+>', '', t)
    return re.sub(r'\s+',' ', html.unescape(t)).strip()

BOT_NAMES={'Botcake'}
# tin hệ thống / trả lời tự động — KHÔNG tính là sale phản hồi
SYS = re.compile(r'đã trả lời (một|về một) (quảng cáo|bài viết)|bạn đang phản hồi bình luận|vui lòng nhắn tin cho bên em|vui lòng đợi (giây lát|một chút)|kết nối (với )?nhân viên|kính chào anh/chị|trân trọng xin chào|hân hạnh được kết nối|xin phép kết nối lại', re.I)
INTENT = re.compile(r'giá|bao nhiêu|bn |bnhiêu|size|kích thước|còn hàng|có bán|mua|ship|đặt|order|tư vấn|mẫu|hình|ảnh|inbox|ib\b|sỉ|đại lý|nhập|combo|khuyến mãi|km\b|bảo hành|đổi trả|chất liệu|gỗ|đồng|cách|hướng dẫn|lắp|giao hàng|phí|freeship|thanh toán|cọc|báo giá|xin|cho e|cho c|cho a|còn ko|còn không|có ko|có không|lấy cho|\?', re.I)

def kind(m):
    """cust | sale | auto  (auto = bot hoặc tin hệ thống, không tính là sale trả lời)"""
    if not m['from_page']: return 'cust'
    if (m['admin'] or '') in BOT_NAMES: return 'auto'
    if SYS.search(clean(m['text'])): return 'auto'
    return 'sale'

# ── NỐI BÌNH LUẬN → TIN NHẮN ───────────────────────────────────
# Luồng thật của page: khách bình luận dưới bài quảng cáo → Botcake rep "vui lòng kiểm tra tin nhắn"
# → sale trả lời tử tế trong INBOX. Nếu chỉ soi trong 1 hội thoại thì bình luận đó luôn bị chấm
# "không trả lời / chỉ bot" dù khách ĐÃ được tư vấn đầy đủ. => Chỉ báo lỗi bình luận khi khách
# KHÔNG được ai trả lời trong tin nhắn.
# Khoá nối: conv INBOX có id = "{page_id}_{fb_id}", conv COMMENT mang fb_id ở customers[0].
# Bản crawl cũ chưa lưu fb_id → fallback khớp theo (page_id, tên khách).
from datetime import datetime, timedelta
def _plus_hours(iso, h):
    try: return (datetime.fromisoformat(iso[:26]) + timedelta(hours=h)).isoformat()
    except Exception: return iso[:10] + 'T99'

def _sale_reply_times(c):
    # Mốc thời gian các lượt sale THẬT (không bot/hệ thống) trả lời trong 1 hội thoại
    out=[]
    for m in c['messages']:
        if not m['from_page']: continue
        if (m['admin'] or '') in BOT_NAMES: continue
        if SYS.search(clean(m['text'])): continue
        if not clean(m['text']): continue   # ảnh trần không tính là đã tư vấn
        out.append(m['at'])
    return out

inbox_by_fb, inbox_by_name, inbox_any_page = {}, {}, {}
for c in d:
    if c.get('type')!='INBOX': continue
    ts=_sale_reply_times(c)
    if not ts: continue
    pid=str(c.get('page_id') or '')
    fb=str(c.get('fb_id') or '') or (c['conv_id'].split('_',1)[1] if '_' in c['conv_id'] else '')
    if fb: inbox_by_fb.setdefault((pid,fb),[]).extend(ts)
    nm=(c.get('customer') or '').strip().lower()
    if nm:
        inbox_by_name.setdefault((pid,nm),[]).extend(ts)
        inbox_any_page.setdefault(nm,[]).extend(ts)

def answered_in_inbox(c, after_at):
    # Khách của hội thoại `c` có được sale trả lời trong INBOX kể từ mốc `after_at` không
    pid=str(c.get('page_id') or '')
    buckets=[]
    fb=str(c.get('fb_id') or '')
    if fb: buckets.append(inbox_by_fb.get((pid,fb)))
    nm=(c.get('customer') or '').strip().lower()
    if nm: buckets.append(inbox_by_name.get((pid,nm)))
    for ts in buckets:
        if ts and any(t>=after_at for t in ts): return True
    # Cùng thương hiệu nhưng KHÁC page: 1 brand có nhiều fanpage (VD "Đồ Thờ Nhập Khẩu Chánh Tâm"
    # và "Chánh Tâm - Không Gian Tâm Linh"), khách bình luận page này lại được rep inbox page kia.
    # Chỉ khớp theo tên + trong vòng 6 GIỜ để không vơ nhầm người trùng tên ở thời điểm khác.
    ts = inbox_any_page.get(nm)
    if ts:
        lim = _plus_hours(after_at, 6)
        if any(after_at <= t <= lim for t in ts): return True
    return False

pairs=[]
for c in d:
    msgs=[m for m in c['messages'] if clean(m['text']) or m.get('has_attach')]
    for m in msgs: m['_k']=kind(m)
    real=[m for m in msgs if m['_k']!='auto']
    turns=[]
    for m in real:
        if turns and turns[-1]['side']==m['_k']: turns[-1]['msgs'].append(m)
        else: turns.append({'side':m['_k'],'msgs':[m]})
    for i,t in enumerate(turns):
        if t['side']!='cust': continue
        ask=' '.join([x for x in (clean(m['text']) for m in t['msgs']) if x]).strip()
        first_at=t['msgs'][0]['at']; last_at=t['msgs'][-1]['at']
        if not ('2026-08-22' <= first_at[:10] <= '2026-08-24'): continue
        if len(ask)<=8 or not INTENT.search(ask): continue
        nxt = turns[i+1] if i+1<len(turns) else None   # lượt kế tiếp chắc chắn là 'sale' (đã bỏ auto)
        reply=None; sale=None
        if nxt and nxt['side']=='sale':
            txts=[clean(m['text']) for m in nxt['msgs']]
            reply=' | '.join([x for x in txts if x]).strip() or None
            if not reply and any(m.get('has_attach') for m in nxt['msgs']): reply='(gửi ảnh/tệp)'
            for m in nxt['msgs']:
                if m['admin']: sale=m['admin']; break
        # có bot/hệ thống trả lời sau lượt này không?
        bot_after=any(m['_k']=='auto' and m['at']>last_at for m in msgs)
        # Bình luận chưa ai rep TẠI CHỖ nhưng khách đã được sale tư vấn trong inbox → KHÔNG tính lỗi
        in_inbox = (not reply) and c.get('type')=='COMMENT' and answered_in_inbox(c, last_at)
        pairs.append({
            'page':c['page_name'],'conv_id':c['conv_id'],'type':c['type'],
            'customer':c['customer'],'phone':c['phone'],
            'sale': sale or (c['assignees'][0] if c['assignees'] else None),
            'date':first_at[:10],'ask':ask[:700],
            'reply':(reply[:1000] if reply else None),
            'bot_only': (not reply) and bot_after and not in_inbox,
            'answered_in_inbox': in_inbox,
        })
json.dump(pairs, open('pairs_v3.json','w'), ensure_ascii=False, indent=1)

from collections import Counter
print('tổng lượt:',len(pairs))
print('có sale trả lời:',sum(1 for p in pairs if p['reply']))
print('chỉ bot trả lời:',sum(1 for p in pairs if p['bot_only']))
print('bình luận → đã tư vấn trong inbox (KHÔNG tính lỗi):',sum(1 for p in pairs if p['answered_in_inbox']))
print('hoàn toàn không ai trả lời:',sum(1 for p in pairs if not p['reply'] and not p['bot_only'] and not p['answered_in_inbox']))
for name in ['Trần Hương','Hùng Thái Văn','Mochi']:
    got=[p for p in pairs if p['customer']==name]
    print(f"\n-- {name}: {len(got)} lượt")
    for p in got:
        st='SALE: '+p['reply'][:70] if p['reply'] else ('CHỈ BOT' if p['bot_only'] else 'KHÔNG AI TRẢ LỜI')
        print('   ',p['ask'][:60],'→',st)
