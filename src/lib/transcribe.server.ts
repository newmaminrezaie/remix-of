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

  const res = await fetch(AVANEGAR_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "gateway-system": "sahab",
      "gateway-token": AVANEGAR_TOKEN,
    },
    body: JSON.stringify({ language: "fa", data: clean }),
  });

  const text = await res.text();
  if (!res.ok) {
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
