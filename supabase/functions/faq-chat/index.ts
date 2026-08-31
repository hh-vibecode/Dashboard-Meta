// Edge Function: faq-chat
// Nhận 1 câu hỏi từ ô "QnA" trên trang FAQ Sản Phẩm, trả lời dựa CHỈ trên bảng product_faq (closed-book QA),
// gọi qua OpenAI Chat Completions API. Deploy: supabase functions deploy faq-chat --project-ref bcrpxfvvjsjpvbksqzls
// Secret cần set 1 lần: supabase secrets set OPENAI_API_KEY=sk-... --project-ref bcrpxfvvjsjpvbksqzls
// (SUPABASE_URL / SUPABASE_ANON_KEY đã có sẵn tự động trong mọi Edge Function, không cần set tay.)

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
// Đã đo thực tế trên chính bộ 263 FAQ (~68k token/câu hỏi vì nhét cả tài liệu vào prompt):
//   gpt-5.4-nano ~30đ/câu · gpt-4.1-nano ~59đ · gpt-4o-mini ~89đ — nano mới nhất vừa rẻ nhất vừa trả lời đầy đủ nhất.
// LƯU Ý: dòng gpt-5.x dùng "max_completion_tokens" (không phải "max_tokens") và cần đủ hạn mức token,
// nếu đặt quá thấp model sẽ tiêu hết vào phần suy luận và trả về nội dung RỖNG.
const OPENAI_MODEL = "gpt-5.4-nano";
// Model cho câu hỏi CÓ ẢNH. Đã test 4 vòng bằng ảnh chứa số ngẫu nhiên (không đoán mò được):
//   gpt-5.4-nano 0/4 (bịa hoàn toàn) · gpt-5-nano 3/4 · gpt-4.1-nano 3/4 · gpt-4o-mini 4/4.
// => model chữ đang dùng KHÔNG đọc được ảnh, phải tự chuyển sang gpt-4o-mini khi có ảnh đính kèm.
// Lưu ý: số token input KHÔNG cho biết model có đọc ảnh hay không (gpt-5-nano chỉ tốn 56 token
// vẫn đọc đúng, còn gpt-5.4-nano tốn tương đương lại đọc sai) — chỉ có test thực nghiệm mới tin được.
const VISION_MODEL = "gpt-4o-mini";
// Đơn giá USD / 1 triệu token (input, output) — đổi nếu OpenAI cập nhật giá hoặc đổi model
const PRICE_PER_1M: Record<string, [number, number]> = {
  "gpt-5.4-nano": [0.05, 0.40], "gpt-5-nano": [0.05, 0.40],
  "gpt-4.1-nano": [0.10, 0.40], "gpt-4o-mini": [0.15, 0.60],
};
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Chỉ nhận POST" }, 405);

  let body: { question?: string; history?: { role: string; content: string }[]; images?: string[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body không phải JSON hợp lệ" }, 400);
  }

  const question = (body.question || "").trim();
  // Chỉ nhận data URL ảnh, tối đa 3 tấm — chặn URL ngoài để không biến hàm này thành công cụ tải hộ.
  const images = (Array.isArray(body.images) ? body.images : [])
    .filter((u) => typeof u === "string" && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(u))
    .slice(0, 3);
  if (!question && !images.length) return json({ error: "Thiếu câu hỏi" }, 400);
  const hasImg = images.length > 0;
  const MODEL = hasImg ? VISION_MODEL : OPENAI_MODEL;
  const IS_GPT5 = MODEL.startsWith("gpt-5");
  if (!OPENAI_API_KEY) return json({ error: "Server chưa cấu hình OPENAI_API_KEY (chạy: supabase secrets set OPENAI_API_KEY=...)" }, 500);

  // Dữ liệu nhỏ (~260 câu, dưới 200KB) nên nhét thẳng toàn bộ vào system prompt (closed-book, không cần RAG).
  // Nếu sau này product_faq phình to (vài nghìn dòng), đổi đoạn này sang query lọc theo từ khoá/embedding trước khi gửi.
  let faq: { category: string; subcategory: string | null; question: string; answer: string }[] = [];
  try {
    const faqRes = await fetch(
      `${SUPABASE_URL}/rest/v1/product_faq?select=category,subcategory,question,answer&order=category.asc`,
      { headers: { apikey: SUPABASE_ANON_KEY!, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } },
    );
    if (!faqRes.ok) throw new Error(`Supabase lỗi ${faqRes.status}`);
    faq = await faqRes.json();
  } catch (e) {
    return json({ error: `Không tải được kiến thức sản phẩm: ${(e as Error).message}` }, 502);
  }

  const context = faq
    .map((f) => `[${f.category}${f.subcategory ? " / " + f.subcategory : ""}]\nQ: ${f.question}\nA: ${f.answer}`)
    .join("\n\n");

  const systemPrompt =
    `Bạn là trợ lý tư vấn sản phẩm đồ thờ, hỗ trợ nhân viên sales và trả lời khách hàng.\n` +
    `CHỈ được trả lời dựa trên phần "KIẾN THỨC SẢN PHẨM" dưới đây — đây là toàn bộ những gì bạn được phép biết.\n` +
    `Được phép diễn giải/tổng hợp linh hoạt trong phạm vi đó, nhưng TUYỆT ĐỐI không thêm thông tin ngoài phạm vi.\n\n` +
    `CÁCH TRẢ LỜI (bắt buộc):\n` +
    `- Ngắn gọn, đi thẳng vào việc. Tối đa khoảng 6 dòng, trừ khi câu hỏi thực sự cần liệt kê dài.\n` +
    `- KHÔNG mở đầu dài dòng, không nhắc lại câu hỏi, không nói "theo kiến thức bên em".\n` +
    `- Nếu KHÔNG có dữ liệu: nói đúng 1 câu ngắn là chưa có thông tin về mục đó, rồi DỪNG. ` +
    `Không suy đoán sang chủ đề gần giống, không nêu nguyên tắc chung chung để lấp chỗ trống.\n` +
    `- Chỉ hỏi lại khi thực sự cần để trả lời đúng, và tối đa 1 câu hỏi.\n` +
    `- Viết như nhân viên tư vấn đang nhắn tin cho khách: câu chữ tự nhiên, xưng "em", gọi khách là "mình"/"anh/chị".\n` +
    `- TUYỆT ĐỐI KHÔNG dùng ký hiệu định dạng Markdown: không dùng ** để in đậm, không dùng *, __, #, \`. ` +
    `Viết chữ thường bình thường. Muốn nhấn mạnh con số thì cứ viết thẳng ra, không bôi đậm.\n` +
    `- Khi liệt kê thì mỗi ý xuống dòng, bắt đầu bằng dấu gạch ngang "- ".\n` +
    `- Luôn viết hoa đầu câu và viết hoa tên riêng cho đúng chính tả, kể cả khi khách gõ tắt hoặc gõ thường.\n\n` +
    (hasImg
      ? `\nNGƯỜI DÙNG CÓ GỬI KÈM ẢNH:\n` +
        `- Mô tả/nhận định những gì NHÌN THẤY trong ảnh (loại sản phẩm, chất liệu, tư thế, chữ trên ảnh...).\n` +
        `- Rồi đối chiếu với KIẾN THỨC SẢN PHẨM để tư vấn.\n` +
        `- Bạn KHÔNG có kho ảnh sản phẩm để tra mã hàng. Nếu không chắc chắn đó là mẫu nào thì nói thẳng ` +
        `là nhìn ảnh chỉ nhận định được đến đâu, TUYỆT ĐỐI không bịa mã hàng hay giá cụ thể.\n`
      : ``) +
    `\n=== KIẾN THỨC SẢN PHẨM ===\n${context}`;

  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
  const userContent = hasImg
    ? [
      { type: "text", text: question || "Xem ảnh này giúp em, đây là sản phẩm gì và tư vấn thế nào?" },
      ...images.map((u) => ({ type: "image_url", image_url: { url: u, detail: "low" } })),
    ]
    : question;
  const messages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: userContent }];

  try {
    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.3,
        ...(IS_GPT5 ? { max_completion_tokens: 900 } : { max_tokens: 700 }),
      }),
    });
    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return json({ error: `OpenAI lỗi: ${errText.slice(0, 400)}` }, 502);
    }
    const aiData = await aiRes.json();
    const answer = aiData?.choices?.[0]?.message?.content?.trim() || "(không có phản hồi)";

    // Ghi nhận lượng token + chi phí của lần hỏi này để dashboard hiển thị (không chặn câu trả lời nếu ghi lỗi)
    const pt = aiData?.usage?.prompt_tokens ?? 0, ct = aiData?.usage?.completion_tokens ?? 0;
    const [pin, pout] = PRICE_PER_1M[MODEL] ?? [0, 0];
    const cost = (pt / 1e6) * pin + (ct / 1e6) * pout;
    if (SERVICE_KEY) {
      fetch(`${SUPABASE_URL}/rest/v1/faq_chat_usage`, {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, prompt_tokens: pt, completion_tokens: ct, cost_usd: cost, question: ((hasImg ? `[${images.length} ảnh] ` : "") + question).slice(0, 500) }),
      }).catch(() => {});
    }
    return json({ answer, model: MODEL, usage: { prompt_tokens: pt, completion_tokens: ct, cost_usd: cost } });
  } catch (e) {
    return json({ error: `Lỗi gọi OpenAI: ${(e as Error).message}` }, 502);
  }
});
