import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mic, Square, Sparkles, X, Check, Loader2 } from "lucide-react";
import { parseSpeechToDoc, type ParsedDoc } from "@/lib/ai-parse.functions";
import { transcribeSpeech } from "@/lib/transcribe.functions";
import { createSale, createPurchase } from "@/lib/documents.functions";
import { listCustomers, saveCustomer } from "@/lib/customers.functions";
import { formatToman, toFa } from "@/lib/format";

// Chrome (Android) provides webkitSpeechRecognition. This is a web app that
// runs in Chrome mobile per the owner, so we lean on the built-in engine.
type SR = {
  new (): {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onresult: (e: { results: { transcript: string }[][] & { isFinal?: boolean }[] }) => void;
    onerror: (e: { error: string }) => void;
    onend: () => void;
    start: () => void;
    stop: () => void;
  };
};
type RecognitionInstance = InstanceType<SR>;
type MicPermissionDiagnostic = {
  secure: boolean;
  permission: PermissionState | "unsupported" | "unknown";
  hasMediaDevices: boolean;
};

function getSR(): SR | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { webkitSpeechRecognition?: SR; SpeechRecognition?: SR };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

async function getMicPermissionDiagnostic(): Promise<MicPermissionDiagnostic> {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { secure: false, permission: "unknown", hasMediaDevices: false };
  }

  let permission: MicPermissionDiagnostic["permission"] = "unsupported";
  if (navigator.permissions?.query) {
    try {
      const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
      permission = status.state;
    } catch {
      permission = "unknown";
    }
  }

  return {
    secure: window.isSecureContext,
    permission,
    hasMediaDevices: !!navigator.mediaDevices?.getUserMedia,
  };
}

function speechErrorMessage(error: string, diagnostic?: MicPermissionDiagnostic): string | null {
  if (error === "aborted") return null;
  if (error === "no-speech") return "صدایی شنیده نشد، دوباره تلاش کنید.";
  if (error === "network") return "اتصال اینترنت برای تشخیص گفتار لازم است.";
  if (error === "audio-capture") return "میکروفونی پیدا نشد.";

  if (error === "not-allowed" || error === "service-not-allowed") {
    if (diagnostic && !diagnostic.secure) {
      return "مجوز میکروفون ممکن است در تنظیمات Allow باشد، اما Chrome روی موبایل ضبط صدا را فقط روی آدرس امن HTTPS فعال می‌کند. برنامه را با دامنه HTTPS باز کنید، نه با http یا IP مستقیم.";
    }

    if (diagnostic?.permission === "denied") {
      return "مجوز میکروفون برای این سایت در Chrome رد شده است. از قفل کنار آدرس، Microphone را روی Allow بگذارید و صفحه را دوباره باز کنید.";
    }

    if (diagnostic?.permission === "granted") {
      return "مجوز میکروفون داده شده، اما سرویس تبدیل گفتار Chrome شروع نشد. معمولاً با دامنه HTTPS، آپدیت Chrome و Google app، خاموش کردن VPN/Private DNS، یا پاک کردن Site settings همین سایت حل می‌شود.";
    }

    if (diagnostic && !diagnostic.hasMediaDevices) {
      return "این نسخه Chrome دسترسی ضبط صدا را برای این آدرس فعال نکرده است. برنامه را با دامنه HTTPS و Chrome به‌روز باز کنید.";
    }

    return "Chrome اجازه شروع تشخیص صدا را نداد. اگر مجوز را داده‌اید، حتماً برنامه را با دامنه HTTPS باز کنید و سپس صفحه را دوباره بارگذاری کنید.";
  }

  return `خطای صدا: ${error}`;
}

export function VoiceEntry() {
  const [open, setOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [checkingMic, setCheckingMic] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [manual, setManual] = useState("");
  const [mode, setMode] = useState<"browser" | "server">("browser");
  const [uploading, setUploading] = useState(false);
  const [parsed, setParsed] = useState<ParsedDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<RecognitionInstance | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const qc = useQueryClient();

  const supported = !!getSR();

  const parseMut = useMutation({
    mutationFn: (text: string) => parseSpeechToDoc({ data: { text } }),
    onSuccess: (d) => setParsed(d),
    onError: (e: Error) => setError(e.message || "خطا در تشخیص"),
  });

  const saveMut = useMutation({
    mutationFn: async (p: ParsedDoc) => {
      let customer_id: number | null = null;
      if (p.customer_name && p.customer_name.trim()) {
        const name = p.customer_name.trim();
        const existing = await listCustomers({ data: { q: name } });
        const found = existing.find((c) => c.name.trim() === name);
        const cust = found ?? (await saveCustomer({ data: { name } }));
        customer_id = cust.id;
      }
      const total = p.items.reduce((s, it) => s + Math.round(it.quantity * it.unit_price_toman), 0);
      const paid_toman =
        p.paid_toman != null ? Math.min(p.paid_toman, total) : p.kind === "sale" ? 0 : total;
      const items = p.items.map((it) => ({
        product_id: null,
        description: it.description,
        quantity: it.quantity,
        unit_price_toman: it.unit_price_toman,
      }));
      if (p.kind === "sale") {
        if (!customer_id) throw new Error("برای فروش، نام مشتری را بگویید");
        return createSale({
          data: { customer_id, items, paid_toman, notes: p.notes ?? null },
        });
      }
      return createPurchase({
        data: { customer_id, items, paid_toman, notes: p.notes ?? null },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries();
      reset();
      setOpen(false);
    },
    onError: (e: Error) => setError(e.message || "خطا در ذخیره"),
  });

  function reset() {
    setTranscript("");
    setParsed(null);
    setError(null);
    setListening(false);
  }

  async function requestMicAccess() {
    setError(null);
    if (typeof window !== "undefined" && !window.isSecureContext) {
      setError(
        "برای استفاده از میکروفون باید سایت با HTTPS باز شود (آدرس امن). با http:// کروم دسترسی میکروفون را رد می‌کند.",
      );
      return;
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError(
        "این مرورگر اجازه درخواست مستقیم میکروفون را نمی‌دهد. از Chrome به‌روز استفاده کنید.",
      );
      return;
    }

    setCheckingMic(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setMicReady(true);
      setError(null);
    } catch (e) {
      const diagnostic = await getMicPermissionDiagnostic();
      const message = e instanceof DOMException ? e.name : "not-allowed";
      setError(
        speechErrorMessage(message === "NotAllowedError" ? "not-allowed" : message, diagnostic),
      );
    } finally {
      setCheckingMic(false);
    }
  }

  function start() {
    const SRCtor = getSR();
    if (!SRCtor) {
      setError("این مرورگر از تشخیص صدا پشتیبانی نمی‌کند. لطفاً از Chrome استفاده کنید.");
      return;
    }
    if (typeof window !== "undefined" && !window.isSecureContext) {
      setError(
        "برای استفاده از میکروفون باید سایت با HTTPS باز شود (آدرس امن). با http:// کروم دسترسی میکروفون را رد می‌کند.",
      );
      return;
    }
    if (!micReady) {
      setError("اول با دکمه کوچک، دسترسی میکروفون را فعال کنید؛ بعد دکمه بزرگ ضبط را بزنید.");
      return;
    }
    reset();
    const rec = new SRCtor();
    rec.lang = "fa-IR";
    rec.continuous = false;
    rec.interimResults = true;
    let finalText = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      setTranscript((finalText + " " + interim).trim());
    };
    rec.onerror = (ev) => {
      setListening(false);
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        void getMicPermissionDiagnostic().then((diagnostic) => {
          const msg = speechErrorMessage(ev.error, diagnostic);
          if (msg) setError(msg);
        });
        return;
      }

      const msg = speechErrorMessage(ev.error);
      if (msg) setError(msg);
    };
    rec.onend = () => {
      setListening(false);
      const text = finalText.trim();
      if (text) parseMut.mutate(text);
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch (e) {
      setListening(false);
      const message = e instanceof Error ? e.message : "start-failed";
      void getMicPermissionDiagnostic().then((diagnostic) => {
        setError(speechErrorMessage("not-allowed", diagnostic) ?? `خطای صدا: ${message}`);
      });
    }
  }

  function stop() {
    try {
      recRef.current?.stop();
    } catch {
      return;
    }
  }

  useEffect(() => {
    return () => {
      try {
        recRef.current?.stop();
      } catch {
        return;
      }
    };
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setError(null);
        }}
        className="group flex w-full items-center gap-4 rounded-3xl bg-gradient-to-l from-violet-500 to-fuchsia-600 p-5 text-white shadow-soft active:scale-[0.99]"
      >
        <div className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-white/20">
          <Mic className="h-9 w-9" />
        </div>
        <div className="flex-1 text-right">
          <div className="flex items-center justify-end gap-1.5 text-2xl font-black">
            <Sparkles className="h-5 w-5" /> با صدا ثبت کن
          </div>
          <div className="mt-1 text-xs opacity-90">مثلاً بگو: «توت خشک نهصد تومان فروختم»</div>
        </div>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center"
          onClick={() => {
            if (!saveMut.isPending) {
              stop();
              setOpen(false);
              reset();
            }
          }}
        >
          <div
            className="w-full max-w-md rounded-t-3xl bg-card p-5 shadow-2xl sm:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <button
                onClick={() => {
                  stop();
                  setOpen(false);
                  reset();
                }}
                className="rounded-full p-1 text-muted-foreground active:bg-accent"
                aria-label="بستن"
              >
                <X className="h-5 w-5" />
              </button>
              <div className="text-base font-black">دستیار هوشمند</div>
            </div>

            {!supported && (
              <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">
                این مرورگر از تشخیص صدا پشتیبانی نمی‌کند. از Google Chrome روی اندروید استفاده کنید.
              </div>
            )}

            {supported && (
              <>
                <div className="flex flex-col items-center gap-3 py-3">
                  <button
                    onClick={requestMicAccess}
                    className={`grid h-12 w-12 place-items-center rounded-full border border-border shadow-soft active:scale-95 disabled:opacity-60 ${
                      micReady
                        ? "bg-success text-success-foreground"
                        : "bg-secondary text-secondary-foreground"
                    }`}
                    aria-label="فعال کردن میکروفون"
                    disabled={checkingMic || listening || parseMut.isPending || saveMut.isPending}
                    type="button"
                  >
                    {checkingMic ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <Mic className="h-5 w-5" />
                    )}
                  </button>
                  {listening ? (
                    <button
                      onClick={stop}
                      className="grid h-24 w-24 place-items-center rounded-full bg-rose-500 text-white shadow-lg animate-pulse"
                      aria-label="توقف"
                    >
                      <Square className="h-10 w-10" />
                    </button>
                  ) : (
                    <button
                      onClick={start}
                      className="grid h-24 w-24 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg disabled:opacity-40"
                      aria-label="ضبط"
                      disabled={!micReady || parseMut.isPending || saveMut.isPending}
                    >
                      <Mic className="h-10 w-10" />
                    </button>
                  )}
                  <div className="text-xs text-muted-foreground">
                    {listening
                      ? "در حال شنیدن... حرف بزنید"
                      : checkingMic
                        ? "در حال درخواست دسترسی میکروفون..."
                        : parseMut.isPending
                          ? "در حال درک..."
                          : parsed
                            ? "بررسی کنید و تأیید بزنید"
                            : micReady
                              ? "حالا دکمه بزرگ ضبط را بزنید"
                              : "اول دکمه کوچک میکروفون را بزنید"}
                  </div>
                </div>

                {transcript && (
                  <div className="mt-2 rounded-2xl border border-border bg-background p-3 text-right text-sm">
                    <div className="mb-1 text-[11px] text-muted-foreground">شنیدم:</div>
                    <div className="font-bold text-foreground">{transcript}</div>
                  </div>
                )}

                {parseMut.isPending && (
                  <div className="mt-3 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> در حال پردازش با هوش مصنوعی...
                  </div>
                )}

                {parsed && !parseMut.isPending && (
                  <ParsedPreview
                    parsed={parsed}
                    onChange={setParsed}
                    onCancel={() => reset()}
                    onConfirm={() => saveMut.mutate(parsed)}
                    saving={saveMut.isPending}
                  />
                )}

                {error && (
                  <div className="mt-3 rounded-xl bg-rose-50 p-3 text-right text-sm text-rose-800">
                    {error}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function ParsedPreview({
  parsed,
  onChange,
  onCancel,
  onConfirm,
  saving,
}: {
  parsed: ParsedDoc;
  onChange: (p: ParsedDoc) => void;
  onCancel: () => void;
  onConfirm: () => void;
  saving: boolean;
}) {
  const total = parsed.items.reduce(
    (s, it) => s + Math.round(it.quantity * it.unit_price_toman),
    0,
  );
  return (
    <div className="mt-4 space-y-3 text-right">
      <div
        className={`inline-block rounded-full px-3 py-1 text-xs font-black ${
          parsed.kind === "sale" ? "bg-emerald-100 text-emerald-800" : "bg-sky-100 text-sky-800"
        }`}
      >
        {parsed.kind === "sale" ? "فروش" : "خرید"}
      </div>

      {parsed.customer_name && (
        <div className="text-sm">
          <span className="text-muted-foreground">مشتری: </span>
          <span className="font-bold">{parsed.customer_name}</span>
        </div>
      )}

      <div className="space-y-2">
        {parsed.items.map((it, i) => (
          <div key={i} className="rounded-2xl border border-border bg-background p-3 text-sm">
            <div className="font-black text-foreground">{it.description}</div>
            <div className="mt-1 flex justify-between text-xs text-muted-foreground num">
              <span>{formatToman(it.unit_price_toman)}</span>
              <span>تعداد: {toFa(it.quantity)}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-between rounded-2xl bg-amber-50 p-3 text-sm">
        <span className="font-black num text-amber-900">{formatToman(total)}</span>
        <span className="text-amber-900/80">جمع کل</span>
      </div>

      {parsed.paid_toman != null && parsed.paid_toman > 0 && (
        <div className="flex justify-between rounded-2xl bg-emerald-50 p-3 text-sm">
          <span className="font-black num text-emerald-800">{formatToman(parsed.paid_toman)}</span>
          <span className="text-emerald-800/80">پرداختی</span>
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button
          onClick={onCancel}
          disabled={saving}
          className="flex-1 rounded-2xl border border-border bg-background py-3 text-sm font-bold active:bg-accent"
        >
          دوباره
        </button>
        <button
          onClick={onConfirm}
          disabled={saving}
          className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-emerald-600 py-3 text-sm font-black text-white active:bg-emerald-700 disabled:opacity-60"
        >
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> در حال ذخیره...
            </>
          ) : (
            <>
              <Check className="h-4 w-4" /> تأیید و ذخیره
            </>
          )}
        </button>
      </div>

      <button
        onClick={() => onChange({ ...parsed, kind: parsed.kind === "sale" ? "purchase" : "sale" })}
        className="w-full pt-1 text-xs text-muted-foreground underline"
      >
        اشتباه است؟ تغییر به {parsed.kind === "sale" ? "خرید" : "فروش"}
      </button>
    </div>
  );
}
