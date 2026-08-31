// Edge Function: csv-proxy
// Proxy server-side cho các file CSV Google Sheets published — thay thế 3 proxy công cộng miễn phí
// (allorigins.win, corsproxy.io, thingproxy.freeboard.io) hay bị timeout/403 dưới tải đồng thời, gây mất
// hẳn data 1 sheet (đã 2 lần trong 1 ngày làm "Doanh Số" ra 0đ vì Sale Online Master không tải được).
// Chỉ cho phép fetch đúng domain docs.google.com để tránh biến hàm này thành proxy mở cho URL bất kỳ.
// Deploy: supabase functions deploy csv-proxy --project-ref bcrpxfvvjsjpvbksqzls --no-verify-jwt

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const target = new URL(req.url).searchParams.get("url");
  if (!target) return new Response("Thiếu tham số url", { status: 400, headers: corsHeaders });

  let u: URL;
  try { u = new URL(target); } catch { return new Response("URL không hợp lệ", { status: 400, headers: corsHeaders }); }
  if (u.hostname !== "docs.google.com") {
    return new Response("Chỉ cho phép proxy docs.google.com", { status: 403, headers: corsHeaders });
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(u.toString(), { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(timer);
    const text = await res.text();
    return new Response(text, {
      status: res.ok ? 200 : 502,
      headers: { ...corsHeaders, "Content-Type": "text/csv; charset=utf-8" },
    });
  } catch (e) {
    return new Response(`Proxy lỗi: ${(e as Error).message}`, { status: 502, headers: corsHeaders });
  }
});
