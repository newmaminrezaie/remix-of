// Server-side Persian speech-to-text via Sahab / آوانگار (works from Iran,
// unlike Chrome's built-in Google speech service).
const AVANEGAR_TOKEN =
  process.env.AVANEGAR_TOKEN ??
  "eyJhbGciOiJIUzI1NiJ9.eyJzeXN0ZW0iOiJzYWhhYiIsImNyZWF0ZVRpbWUiOiIxNDA1MDUwNjE5MjcyMzQ0OCIsInVuaXF1ZUZpZWxkcyI6eyJ1c2VybmFtZSI6IjUwNDU3N2IyLWIxMjctNDEzZC1iM2E4LWQ3MjY1MTU2YmJlYyJ9LCJncm91cE5hbWUiOiI5YjBiNTQzNzk1NDQzZjA5YzNjNjI1N2YxMTQ3NDk4YyIsImRhdGEiOnsic2VydmljZUlEIjoiNGVkNzY5ZTYtNDgxNC00ZGNiLWEzZWQtZTU1ZWI5Y2FiZjhlIiwicmFuZG9tVGV4dCI6IllINnhvIn19.HCJtzeGghI0D-cS1GPGhNm_qG8TqrHHbtvcAtWqQWto";
const AVANEGAR_URL = "https://partai.gw.isahab.ir/speechRecognition/v1/base64";

function pickText(value: unknown, depth = 0): string {
  if (depth > 6 || value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => pickText(v, depth + 1)).join(" ");
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    for (const key of ["result", "text", "data", "transcript", "value"]) {
      if (key in o) {
        const t = pickText(o[key], depth + 1);
        if (t.trim()) return t;
      }
    }
  }
  return "";
}

// OpenAI-compatible fallback (reachable from outside Iran, e.g. the Lovable
// preview sandbox). Defaults to Requesty, overridable per environment.
const STT_API_URL = process.env.STT_API_URL ?? "https://router.requesty.ai/v1/audio/transcriptions";
const STT_API_KEY =
  process.env.STT_API_KEY ??
  "rqsty-sk-yDk9nyFNQo2tQy/z+RGheQFtCltlzVli1jZlR9U3gy5RuYZmfdX41DPTxoKULGfVVI0Fs3JnBSBjEM4M0lxmcT0oP6dPOr7jKzhdqh6/KwY=";
const STT_MODEL = process.env.STT_MODEL ?? "openai/whisper-1";

async function transcribeViaOpenAiCompatible(bin: Uint8Array): Promise<string> {
  const form = new FormData();
  form.append("model", STT_MODEL);
  form.append("language", "fa");
  form.append("file", new Blob([bin as unknown as BlobPart], { type: "audio/wav" }), "recording.wav");

  const res = await fetch(STT_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${STT_API_KEY}` },
    body: form,
  });
  const body = await res.text();
  if (!res.ok) {
    if (res.status === 402) {
      throw new Error("اعتبار سرویس تبدیل گفتار تمام شده است. فعلاً از ورود متنی استفاده کنید.");
    }
    throw new Error(`خطای تبدیل گفتار پشتیبان (${res.status})`);
  }
  let out = "";
  try {
    out = pickText(JSON.parse(body));
  } catch {
    out = body;
  }
  return out.trim();
}

export async function transcribeAudio(base64: string, mime: string): Promise<string> {
  const clean = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
  const bin = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  if (bin.byteLength < 2048) throw new Error("ضبط خیلی کوتاه بود، دوباره تلاش کنید.");
  if (bin.byteLength > 20 * 1024 * 1024) throw new Error("فایل صدا خیلی بزرگ است.");
  const base = mime.split(";")[0];
  if (base && !base.includes("wav")) {
    // Avanegar accepts wav/mp3; the client converts before upload.
    throw new Error("فرمت صدا پشتیبانی نمی‌شود، دوباره ضبط کنید.");
  }

  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      res = await fetch(AVANEGAR_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "gateway-system": "sahab",
          "gateway-token": AVANEGAR_TOKEN,
        },
        body: JSON.stringify({ language: "fa", data: clean }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Avanegar only accepts connections from inside Iran; outside it we fall
    // back to the OpenAI-compatible provider automatically.
    console.error("avanegar fetch failed, trying fallback", err);
    const fallback = await transcribeViaOpenAiCompatible(bin);
    if (!fallback) throw new Error("چیزی شنیده نشد، دوباره تلاش کنید.");
    return fallback;
  }

  const text = await res.text();
  if (!res.ok) {
    console.error("avanegar http error", res.status, text.slice(0, 300));
    const fallback = await transcribeViaOpenAiCompatible(bin);
    if (fallback) return fallback;
    if (res.status === 401 || res.status === 403) {
      throw new Error("توکن سرویس آوانگار معتبر نیست یا منقضی شده است.");
    }
    throw new Error(`خطای تبدیل گفتار (${res.status})`);
  }
  let out = "";
  try {
    out = pickText(JSON.parse(text));
  } catch {
    out = text;
  }
  out = out.trim();
  if (!out) throw new Error("چیزی شنیده نشد، دوباره تلاش کنید.");
  return out;
}
