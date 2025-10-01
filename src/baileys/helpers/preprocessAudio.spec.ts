import { describe, it } from "bun:test";

describe("preprocessAudio", () => {
  describe("#preprocessAudio", () => {
    describe("when the audio is in wav format", () => {
      it.todo("returns the processed audio in wav format");
    });

    describe("when the audio is in ogg-low format", () => {
      it.todo("returns the processed audio in ogg-low format");
    });

    describe("when the audio is in mp3-high format", () => {
      it.todo("returns the processed audio in ogg-high format");
    });

    describe("when an error occurs during processing", () => {
      it.todo("throws an error");
    });
  });

  describe("#bufferToStream", () => {
    it.todo("converts a buffer to a readable stream");
  });
});
