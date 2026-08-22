import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cancelAudioJob,
  completeAudioJob,
  registerAudioJob,
  runningAudioJobCount,
} from "@/baileys/helpers/audioJobs";

describe("audioJobs", () => {
  beforeEach(() => {
    // Ids are unique per process in the worker, so leaking across examples here
    // would hide a registry that never empties.
    for (let id = 0; id < 10; id++) {
      completeAudioJob(id);
    }
  });

  // The reason this registry exists: the worker's onmessage is async, so it has
  // already started an ffmpeg child process and moved on to the next message.
  // Abandoning the promise leaves that process running until it finishes on its
  // own, which for the wedged conversion the deadline exists for is never.
  it("kills the ffmpeg command behind an abandoned job", () => {
    const kill = mock(() => {});
    registerAudioJob(1, { kill });

    expect(cancelAudioJob(1)).toBe(true);
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(runningAudioJobCount()).toBe(0);
  });

  // A job that finished normally is gone, so a cancel arriving late must be a
  // no-op rather than reach into a command that has already been cleaned up.
  it("is inert for a job that already completed", () => {
    const kill = mock(() => {});
    registerAudioJob(2, { kill });
    completeAudioJob(2);

    expect(cancelAudioJob(2)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("is inert for a job it never saw", () => {
    expect(cancelAudioJob(3)).toBe(false);
  });
});
