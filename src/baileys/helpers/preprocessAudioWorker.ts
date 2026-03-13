import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import ffmpeg from "@/bindings/ffmpeg";

declare var self: Worker;

function bufferToStream(buffer: Buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

async function processAudio(
  audio: Buffer,
  format: "ogg-low" | "mp3-high" | "wav",
): Promise<Buffer> {
  const tmpFilename = join(
    tmpdir(),
    `audio-${randomBytes(6).toString("hex")}.${format}`,
  );
  try {
    const command = ffmpeg(bufferToStream(audio));

    if (format === "wav") {
      command
        .audioCodec("pcm_s16le")
        .format("wav")
        .audioFrequency(16000)
        .audioChannels(1);
    }
    if (format === "ogg-low") {
      command
        .audioCodec("libopus")
        .format("ogg")
        .audioBitrate("48k")
        .audioChannels(1);
    }
    if (format === "mp3-high") {
      command
        .audioCodec("libmp3lame")
        .format("mp3")
        .audioFrequency(44100)
        .audioChannels(2)
        .audioBitrate("128k");
    }

    await new Promise<void>((ffResolve, ffReject) =>
      command
        .on("end", () => ffResolve())
        .on("error", (err) => ffReject(err))
        .save(tmpFilename),
    );
    return await fs.readFile(tmpFilename);
  } finally {
    try {
      await fs.unlink(tmpFilename);
    } catch {
      // Ignore cleanup errors in worker
    }
  }
}

self.onmessage = async (
  event: MessageEvent<{
    id: number;
    audio: ArrayBuffer;
    format: "ogg-low" | "mp3-high" | "wav";
  }>,
) => {
  const { id, audio, format } = event.data;
  try {
    const result = await processAudio(Buffer.from(audio), format);
    const arrayBuffer = new Uint8Array(result).buffer as ArrayBuffer;
    self.postMessage({ id, result: arrayBuffer }, [arrayBuffer]);
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
