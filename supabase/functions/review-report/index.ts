// Edge Function: review-report
// Nhận báo lỗi "chấm sai" từ trang Chất Lượng Phản Hồi Sale (bảng sale_review_report).
// Mục đích: user gom nhiều báo lỗi trong vài ngày rồi nhờ Claude sửa một thể, thay vì báo lẻ từng cái.
// Deploy: supabase functions deploy review-report --project-ref bcrpxfvvjsjpvbksqzls --no-verify-jwt
//
// Ghi phải qua đây vì bảng bật RLS, anon chỉ được SELECT. Không cần mật khẩu: MỌI tài khoản đều
// được báo lỗi (giống nút "Báo sai" ở chatbot). Riêng resolve/xoá thì cần mật khẩu tester.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ADMIN_PASS = Deno.env.get("FAQ_ADMIN_PASS");

const KEEP_DAYS = 3;          // giữ báo lỗi 3 ngày rồi dọn
const MAX_IMAGES = 3;
const MAX_IMG_KB = 250;       // client đã nén rồi, đây là chốt chặn cuối

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function sb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY!,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${t.slice(0, 300)}`);
  return t.trim() ? JSON.parse(t) : [];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Chỉ nhận POST" }, 405);
  if (!SERVICE_KEY) return json({ error: "Server thiếu SUPABASE_SERVICE_ROLE_KEY" }, 500);

  // deno-lint-ignore no-explicit-any
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "Body không phải JSON hợp lệ" }, 400); }

  try {
    if (b.action === "add") {
      const note = (b.note || "").toString().trim();
      if (!note) return json({ error: "Chưa ghi lỗi sai ở chỗ nào" }, 400);

      // Chỉ nhận data URL ảnh đã nén; chặn URL ngoài và ảnh quá nặng
      const images = (Array.isArray(b.images) ? b.images : [])
        .filter((u: unknown) =>
          typeof u === "string" &&
          /^data:image\/(png|jpe?g|webp);base64,/.test(u) &&
          (u.length * 0.75) / 1024 <= MAX_IMG_KB
        )
        .slice(0, MAX_IMAGES);

      const row = await sb("sale_review_report", {
        method: "POST",
        body: JSON.stringify({
          review_id: Number.isFinite(b.review_id) ? b.review_id : null,
          conv_date: b.conv_date || null,
          page_name: (b.page_name || "").toString().slice(0, 200),
          customer_name: (b.customer_name || "").toString().slice(0, 200),
          customer_ask: (b.customer_ask || "").toString().slice(0, 1000),
          verdict_old: (b.verdict_old || "").toString().slice(0, 40),
          note: note.slice(0, 2000),
          images,
          reporter: (b.reporter || "").toString().slice(0, 100) || null,
        }),
      });

      // Dọn báo lỗi quá hạn (chạy nền, không chặn phản hồi cho người dùng)
      (async () => {
        try {
          const cut = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
          await sb(`sale_review_report?created_at=lt.${cut}`, { method: "DELETE" });
        } catch { /* bỏ qua */ }
      })();

      return json({ ok: true, id: row?.[0]?.id ?? null });
    }

    if (b.action === "resolve" || b.action === "delete") {
      if (!ADMIN_PASS || b.passphrase !== ADMIN_PASS)
        return json({ error: "Sai mật khẩu — chỉ tài khoản tester được đóng/xoá báo lỗi." }, 403);
      const id = Number(b.id);
      if (!Number.isFinite(id)) return json({ error: "Thiếu id" }, 400);

      if (b.action === "delete") {
        await sb(`sale_review_report?id=eq.${id}`, { method: "DELETE" });
        return json({ ok: true });
      }
      await sb(`sale_review_report?id=eq.${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "fixed",
          resolved_at: new Date().toISOString(),
          resolved_by: (b.actor || "").toString().slice(0, 100) || null,
          resolve_note: (b.resolve_note || "").toString().slice(0, 1000) || null,
        }),
      });
      return json({ ok: true });
    }

    return json({ error: "action không hợp lệ (add | resolve | delete)" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
