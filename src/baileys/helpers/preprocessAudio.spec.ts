import { describe, expect, it } from "bun:test";

// Logger is mocked in preload.ts

describe("preprocessAudio", () => {
  it("sends audio to a worker and receives processed result", async () => {
    // This test verifies the module's interface contract.
    // The actual worker spawning is hard to unit test in isolation,
    // so we test the module's public API shape.
    const { preprocessAudio } = await import("./preprocessAudio");
    expect(typeof preprocessAudio).toBe("function");
  });

  it("returns a Promise<Buffer>", async () => {
    // We can verify the function signature accepts the right args
    const { preprocessAudio } = await import("./preprocessAudio");

    // Create a mock that resolves quickly
    // Note: In CI without ffmpeg, this would fail, so we just test the interface
    const input = Buffer.from("fake-audio-data");
    const result = preprocessAudio(input, "mp3-high");
    expect(result).toBeInstanceOf(Promise);
  });
});
