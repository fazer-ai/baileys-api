import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cancelAudioJob,
  completeAudioJob,
  isAudioJobCancelled,
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

  // fluent-ffmpeg spawns asynchronously: during _prepare and its capability
  // probing there is no ffmpegProc, and kill() only logs. A cancellation that
  // lands in that window has nothing to act on, so it has to be remembered --
  // otherwise the process starts afterwards and runs unbounded, which is exactly
  // what the deadline exists to prevent.
  it("kills a job that had not started when the cancel arrived", () => {
    const kill = mock(() => {});

    expect(cancelAudioJob(4)).toBe(false);
    expect(isAudioJobCancelled(4)).toBe(true);

    registerAudioJob(4, { kill });

    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(runningAudioJobCount()).toBe(0);
  });

  // And the memory of it is bounded: a job that ends clears its own flag, so a
  // later id reusing that number is not born cancelled.
  it("forgets the cancellation once the job is done", () => {
    cancelAudioJob(5);
    expect(isAudioJobCancelled(5)).toBe(true);

    completeAudioJob(5);

    expect(isAudioJobCancelled(5)).toBe(false);
  });
});
