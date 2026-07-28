import { createServerFn } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";
import { z } from "zod";
import { getCurrentUser } from "./auth.server";

// Hardcoded per user request (standalone Amazon VPS deployment).
const REQUESTY_API_KEY =
  "rqsty-sk-yDk9nyFNQo2tQy/z+RGheQFtCltlzVli1jZlR9U3gy5RuYZmfdX41DPTxoKULGfVVI0Fs3JnBSBjEM4M0lxmcT0oP6dPOr7jKzhdqh6/KwY=";
const REQUESTY_URL = "https://router.requesty.ai/v1/chat/completions";
// Free model on Requesty (no per-token cost), good Persian + JSON quality.
const MODEL = "nvidia/nemotron-3-super-120b-a12b";
// Fallback if the primary free model is unavailable.
const FALLBACK_MODEL = "google/gemma-4-31b-it";

const SYSTEM_PROMPT = `شما یک دستیار حسابداری فارسی هستید که گفتار کاربر را به یک سند حسابداری ساختاریافته تبدیل می‌کنید.

کاربر با صدا یا متن فارسی یک فروش یا خرید را بیان می‌کند. مثال‌ها:
- "توت خشک نهصد تومان فروختم" → فروش ۱ عدد توت خشک به قیمت ۹۰۰ تومان
- "دو کیلو زعفران نگین خریدم کیلویی صد هزار تومان" → خرید ۲ کیلو زعفران نگین، قیمت واحد ۱۰۰۰۰۰ تومان
- "به آقای احمدی سه بسته عناب فروختم هر کدام پنجاه هزار تومان، نقدی صد هزار داد" → فروش، مشتری «آقای احمدی»، ۳ عدد عناب × ۵۰۰۰۰، پرداختی ۱۰۰۰۰۰
- "برگه زردآلو دویست هزار تومان خریدیم" → خرید، ۱ × برگه زردآلو، ۲۰۰۰۰۰ تومان

نکات:
- اعداد فارسی حرفی (نهصد، دویست هزار، یک میلیون) را به عدد صحیح تومان تبدیل کن.
- اگر تعداد ذکر نشد، quantity = 1.
- اگر مبلغ ذکر شده «قیمت کل» بود و تعداد بیش از یک، unit_price_toman = کل ÷ تعداد.
- اگر «فروختم/فروختیم» بود kind = "sale"، اگر «خریدم/خریدیم» بود kind = "purchase".
- اگر مشخص نبود، بهترین حدس را بزن.
- paid_toman فقط وقتی مقدار پرداختی صراحتاً ذکر شد.
- unit_price_toman و quantity هرگز null نباشند؛ اگر قیمت مشخص نبود عدد 0 بگذار.

فقط یک JSON معتبر برگردان (بدون توضیح، بدون markdown):
{
  "kind": "sale" | "purchase",
  "customer_name": string | null,
  "paid_toman": number | null,
  "notes": string | null,
  "items": [
    { "description": string, "quantity": number, "unit_price_toman": number }
  ]
}`;

// Models sometimes return null / strings ("۹۰۰", "900,000") for numbers.
const num = (fallback: number | null) =>
  z.preprocess((v) => {
    if (v === null || v === undefined || v === "") return fallback;
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const fa = "۰۱۲۳۴۵۶۷۸۹";
      const ar = "٠١٢٣٤٥٦٧٨٩";
      const normalized = v
        .replace(/[۰-۹]/g, (d) => String(fa.indexOf(d)))
        .replace(/[٠-٩]/g, (d) => String(ar.indexOf(d)))
        .replace(/[,\s\u066c]/g, "");
      const n = Number(normalized);
      return Number.isFinite(n) ? n : fallback;
    }
    return fallback;
  }, fallback === null ? z.number().nullable() : z.number());

const ParsedSchema = z.object({
  kind: z.enum(["sale", "purchase"]),
  customer_name: z.string().nullable().optional(),
  paid_toman: num(null).optional(),
  notes: z.string().nullable().optional(),
  items: z
    .array(
      z.object({
        description: z.string().min(1),
        quantity: num(1).pipe(z.number().positive()),
        unit_price_toman: num(0).pipe(
          z.number().nonnegative().transform((n) => Math.round(n)),
        ),
      }),
    )
    .min(1),
});

export type ParsedDoc = z.infer<typeof ParsedSchema>;

export const parseSpeechToDoc = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ text: z.string().trim().min(1).max(2000) }).parse(d),
  )
  .handler(async ({ data }): Promise<ParsedDoc> => {
    const me = await getCurrentUser();
    if (!me) throw redirect({ to: "/login" });

    const call = (model: string) =>
      fetch(REQUESTY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${REQUESTY_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: data.text },
          ],
        }),
      });

    let res = await call(MODEL);
    if (!res.ok) res = await call(FALLBACK_MODEL);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Requesty ${res.status}: ${body.slice(0, 400)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    let obj: unknown;
    try {
      obj = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("پاسخ هوش مصنوعی معتبر نبود");
      obj = JSON.parse(m[0]);
    }
    return ParsedSchema.parse(obj);
  });
