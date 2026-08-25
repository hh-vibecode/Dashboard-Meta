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
SYS = re.compile(r'đã trả lời (một|về một) (quảng cáo|bài viết)|vui lòng nhắn tin cho bên em|vui lòng đợi giây lát|kính chào anh/chị|trân trọng xin chào', re.I)
INTENT = re.compile(r'giá|bao nhiêu|bn |bnhiêu|size|kích thước|còn hàng|có bán|mua|ship|đặt|order|tư vấn|mẫu|hình|ảnh|inbox|ib\b|sỉ|đại lý|nhập|combo|khuyến mãi|km\b|bảo hành|đổi trả|chất liệu|gỗ|đồng|cách|hướng dẫn|lắp|giao hàng|phí|freeship|thanh toán|cọc|báo giá|xin|cho e|cho c|cho a|còn ko|còn không|có ko|có không|lấy cho|\?', re.I)

def kind(m):
    """cust | sale | auto  (auto = bot hoặc tin hệ thống, không tính là sale trả lời)"""
    if not m['from_page']: return 'cust'
    if (m['admin'] or '') in BOT_NAMES: return 'auto'
    if SYS.search(clean(m['text'])): return 'auto'
    return 'sale'

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
        pairs.append({
            'page':c['page_name'],'conv_id':c['conv_id'],'type':c['type'],
            'customer':c['customer'],'phone':c['phone'],
            'sale': sale or (c['assignees'][0] if c['assignees'] else None),
            'date':first_at[:10],'ask':ask[:700],
            'reply':(reply[:1000] if reply else None),
            'bot_only': (not reply) and bot_after,
        })
json.dump(pairs, open('pairs_v3.json','w'), ensure_ascii=False, indent=1)

from collections import Counter
print('tổng lượt:',len(pairs))
print('có sale trả lời:',sum(1 for p in pairs if p['reply']))
print('chỉ bot trả lời:',sum(1 for p in pairs if p['bot_only']))
print('hoàn toàn không ai trả lời:',sum(1 for p in pairs if not p['reply'] and not p['bot_only']))
for name in ['Trần Hương','Hùng Thái Văn','Mochi']:
    got=[p for p in pairs if p['customer']==name]
    print(f"\n-- {name}: {len(got)} lượt")
    for p in got:
        st='SALE: '+p['reply'][:70] if p['reply'] else ('CHỈ BOT' if p['bot_only'] else 'KHÔNG AI TRẢ LỜI')
        print('   ',p['ask'][:60],'→',st)
