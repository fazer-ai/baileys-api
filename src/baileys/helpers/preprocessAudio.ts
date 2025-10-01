import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import ffmpeg from "@/bindings/ffmpeg";
import { errorToString } from "@/helpers/errorToString";
import logger from "@/lib/logger";

function bufferToStream(buffer: Buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

export async function preprocessAudio(
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

    // NOTE: We need to output to a tmp file due to limitations in ffmpeg outputting to a node stream.
    await new Promise<void>((ffResolve, ffReject) =>
      command
        .on("end", () => ffResolve())
        .on("error", (err) => ffReject(err))
        .save(tmpFilename),
    );
    const processedBuffer = await fs.readFile(tmpFilename);

    return processedBuffer;
  } finally {
    try {
      await fs.unlink(tmpFilename);
    } catch (unlinkError) {
      logger.error(
        "Failed to delete temporary audio file: %s",
        errorToString(unlinkError),
      );
    }
  }
}
