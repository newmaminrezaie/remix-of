import { createServerFn } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";
import { z } from "zod";
import { getCurrentUser } from "./auth.server";
import { transcribeAudio } from "./transcribe.server";

export const transcribeSpeech = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        audio_base64: z.string().min(100),
        mime: z.string().default("audio/webm"),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<{ text: string }> => {
    const me = await getCurrentUser();
    if (!me) throw redirect({ to: "/login" });
    return { text: await transcribeAudio(data.audio_base64, data.mime) };
  });
