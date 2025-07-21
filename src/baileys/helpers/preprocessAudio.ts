import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import ffmpeg from "@/bindings/ffmpeg";
import { promisify } from "@/helpers/promisify";

function bufferToStream(buffer: Buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

export async function preprocessAudio(
  audio: Buffer,
  format: "mp3-low" | "mp3-high" | "wav",
): Promise<Buffer> {
  const { promise, resolve, reject } = promisify<Buffer>();

  const tmpFilename = join(
    tmpdir(),
    `audio-${randomBytes(6).toString("hex")}.${format}`,
  );
  try {
    const command = ffmpeg(bufferToStream(audio));

    if (format === "wav") {
      command
        .audioCodec("pcm_s16le")
        .audioFrequency(16000)
        .audioChannels(1)
        .format("wav");
    }
    if (format === "mp3-low") {
      command
        .audioCodec("libmp3lame")
        .audioFrequency(16000)
        .audioChannels(1)
        .audioBitrate("48k")
        .format("mp3");
    }
    if (format === "mp3-high") {
      command
        .audioCodec("libmp3lame")
        .audioFrequency(44100)
        .audioChannels(2)
        .audioBitrate("128k")
        .format("mp3");
    }

    // NOTE: We need to output to a tmp file due to limitations in ffmpeg outputting to a node stream.
    await new Promise<void>((ffResolve, ffReject) =>
      command
        .on("end", () => ffResolve())
        .on("error", (err) => ffReject(err))
        .save(tmpFilename),
    );
    const processedBuffer = await fs.readFile(tmpFilename);

    resolve(processedBuffer);
  } catch (error) {
    reject(error);
  } finally {
    try {
      await fs.unlink(tmpFilename);
    } catch (unlinkError) {
      logger.error("Failed to delete temporary audio file:", unlinkError);
    }
  }

  return promise;
}
