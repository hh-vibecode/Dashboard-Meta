// Edge Function: faq-admin — THÊM / SỬA / XOÁ kiến thức trong bảng product_faq.
//
// BẢO MẬT: anon key nằm công khai trong index.html nên KHÔNG thể dựa vào nó để phân quyền ghi.
// Mọi thao tác ghi ở đây bắt buộc kèm mật khẩu huấn luyện, đối chiếu với secret FAQ_ADMIN_PASS
// trên server. Người dùng thường (sales) chỉ hỏi qua faq-chat — hàm đó không ghi gì vào product_faq,
// nên dù họ nói gì với bot cũng KHÔNG thể thêm/sửa kiến thức.
//
// Mật khẩu huấn luyện = ĐÚNG mật khẩu đăng nhập của nick tester (user muốn dùng chung 1 mật khẩu cho dễ nhớ).
// Nếu đổi mật khẩu nick tester trong AUTH_USERS thì nhớ đổi cả secret này cho khớp.
// Deploy: supabase functions deploy faq-admin --project-ref bcrpxfvvjsjpvbksqzls --no-verify-jwt
// Secret : supabase secrets set FAQ_ADMIN_PASS=... --project-ref bcrpxfvvjsjpvbksqzls

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ADMIN_PASS = Deno.env.get("FAQ_ADMIN_PASS");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function sb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json", Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Chỉ nhận POST" }, 405);
  if (!SERVICE_KEY || !ADMIN_PASS) return json({ error: "Server chưa cấu hình đủ (thiếu FAQ_ADMIN_PASS)" }, 500);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "Body không hợp lệ" }, 400); }

  if (!b.passphrase || b.passphrase !== ADMIN_PASS)
    return json({ error: "Sai mật khẩu huấn luyện — bạn không có quyền sửa kiến thức." }, 403);

  try {
    if (b.action === "add") {
      const { category, subcategory, question, answer } = b.item || {};
      if (!category || !question || !answer) return json({ error: "Cần đủ: nhóm sản phẩm, câu hỏi, câu trả lời." }, 400);
      const row = await sb("product_faq", {
        method: "POST",
        body: JSON.stringify({
          category: String(category).trim(), subcategory: subcategory ? String(subcategory).trim() : null,
          question: String(question).trim(), answer: String(answer).trim(), source_doc: "Nhập tay từ Dashboard",
        }),
      });
      return json({ ok: true, item: row?.[0] });
    }
    if (b.action === "update") {
      if (!b.id) return json({ error: "Thiếu id" }, 400);
      const patch: Record<string, unknown> = {};
      ["category", "subcategory", "question", "answer"].forEach((k) => {
        if (b.item?.[k] !== undefined) patch[k] = b.item[k] === "" ? null : String(b.item[k]).trim();
      });
      const row = await sb(`product_faq?id=eq.${encodeURIComponent(b.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      return json({ ok: true, item: row?.[0] });
    }
    if (b.action === "delete") {
      if (!b.id) return json({ error: "Thiếu id" }, 400);
      await sb(`product_faq?id=eq.${encodeURIComponent(b.id)}`, { method: "DELETE" });
      return json({ ok: true });
    }
    // Báo lỗi: KHÔNG cần mật khẩu ở phía dưới đã chặn rồi, nhưng để tester ghi nhanh khi thấy bot sai
    if (b.action === "flag") {
      const row = await sb("faq_feedback", {
        method: "POST",
        body: JSON.stringify({ question: String(b.question || "").slice(0, 1000), bot_answer: String(b.bot_answer || "").slice(0, 4000), note: b.note ? String(b.note).slice(0, 500) : null }),
      });
      return json({ ok: true, item: row?.[0] });
    }
    // Sửa ngay từ khung chat: lưu câu trả lời đúng thành kiến thức mới, đồng thời đóng phiếu báo lỗi nếu có
    if (b.action === "teach") {
      const { question, answer, category, subcategory, feedback_id } = b;
      if (!question || !answer) return json({ error: "Cần câu hỏi và câu trả lời đúng." }, 400);
      const row = await sb("product_faq", {
        method: "POST",
        body: JSON.stringify({
          category: (category && String(category).trim()) || "Bổ sung từ QnA",
          subcategory: subcategory ? String(subcategory).trim() : null,
          question: String(question).trim(), answer: String(answer).trim(),
          source_doc: "Sửa trực tiếp khi bot trả lời sai",
        }),
      });
      if (feedback_id) {
        await sb(`faq_feedback?id=eq.${encodeURIComponent(feedback_id)}`, {
          method: "PATCH", body: JSON.stringify({ status: "fixed", fixed_faq_id: row?.[0]?.id ?? null }),
        }).catch(() => {});
      }
      return json({ ok: true, item: row?.[0] });
    }
    if (b.action === "resolve") {
      if (!b.id) return json({ error: "Thiếu id" }, 400);
      await sb(`faq_feedback?id=eq.${encodeURIComponent(b.id)}`, { method: "PATCH", body: JSON.stringify({ status: "fixed" }) });
      return json({ ok: true });
    }
    if (b.action === "check") return json({ ok: true });   // dùng để kiểm tra mật khẩu
    return json({ error: "action không hợp lệ" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
