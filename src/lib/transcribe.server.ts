// Server-side speech-to-text fallback for browsers/networks where Chrome's
// built-in Google speech service cannot be reached (common in Iran).
const REQUESTY_API_KEY =
  "rqsty-sk-yDk9nyFNQo2tQy/z+RGheQFtCltlzVli1jZlR9U3gy5RuYZmfdX41DPTxoKULGfVVI0Fs3JnBSBjEM4M0lxmcT0oP6dPOr7jKzhdqh6/KwY=";
const TRANSCRIBE_URL = "https://router.requesty.ai/v1/audio/transcriptions";
const STT_MODEL = "openai/whisper-1";

const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

export async function transcribeAudio(base64: string, mime: string): Promise<string> {
  const clean = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
  const bin = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  if (bin.byteLength < 2048) throw new Error("ضبط خیلی کوتاه بود، دوباره تلاش کنید.");
  if (bin.byteLength > 20 * 1024 * 1024) throw new Error("فایل صدا خیلی بزرگ است.");

  const base = mime.split(";")[0];
  const ext = EXT[base] ?? "webm";
  const form = new FormData();
  form.append("model", STT_MODEL);
  form.append("language", "fa");
  form.append("file", new Blob([bin], { type: base || "audio/webm" }), `recording.${ext}`);

  const res = await fetch(TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REQUESTY_API_KEY}` },
    body: form,
  });

  const text = await res.text();
  if (!res.ok) {
    if (text.includes("Insufficient balance")) {
      throw new Error(
        "تبدیل گفتار روی سرور نیاز به شارژ حساب Requesty دارد. فعلاً متن را دستی بنویسید.",
      );
    }
    throw new Error(`خطای تبدیل گفتار (${res.status})`);
  }
  let out = "";
  try {
    out = (JSON.parse(text) as { text?: string }).text ?? "";
  } catch {
    out = text;
  }
  out = out.trim();
  if (!out) throw new Error("چیزی شنیده نشد، دوباره تلاش کنید.");
  return out;
}
