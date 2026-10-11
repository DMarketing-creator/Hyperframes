/**
 * Which frames of this render are identical to the frame at the same index of
 * the cached render, by SHA-256 of the frame's image file. A frame whose
 * pixels match but whose file differs counts as changed: that costs an encode
 * and never reuses a wrong frame.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** A half-open run of frame indices, `[startFrame, endFrame)`. */
export interface FrameRun {
  startFrame: number;
  endFrame: number;
}

/** Bytes per frame in the cache's hash file. */
export const FRAME_HASH_BYTES = 32;

/** Frames read per step of the window. */
const WINDOW_FRAMES = 32;

function frameFileName(index: number, ext: string): string {
  return `frame_${String(index).padStart(6, "0")}.${ext}`;
}

/**
 * Hash frames `[0, frameCount)` and compare them with `cachedHashes`, the
 * cached render's hashes laid end to end. Returns every run of identical
 * frames, ascending, and this render's hashes in the same layout. A frame past
 * the end of `cachedHashes` is not identical. Throws when a skipped frame has
 * no cached hash to stand in for it.
 */
export async function findIdenticalFrameRuns(input: {
  framesDir: string;
  frameExt: "jpg" | "png";
  frameCount: number;
  cachedHashes: Uint8Array;
  /** Frames with no file, ascending and disjoint. */
  skippedRuns?: readonly FrameRun[];
  signal?: AbortSignal;
}): Promise<{ runs: FrameRun[]; hashes: Buffer }> {
  const { framesDir, frameExt, frameCount, signal } = input;
  const cachedFrames = Math.floor(input.cachedHashes.length / FRAME_HASH_BYTES);
  const skipped = skippedFrameMask(input.skippedRuns ?? [], Math.min(frameCount, cachedFrames));
  const cachedHashes = Buffer.from(
    input.cachedHashes.buffer,
    input.cachedHashes.byteOffset,
    input.cachedHashes.byteLength,
  );
  const hashes = Buffer.alloc(frameCount * FRAME_HASH_BYTES);
  const identical = new Uint8Array(frameCount);
  for (let windowStart = 0; windowStart < frameCount; windowStart += WINDOW_FRAMES) {
    signal?.throwIfAborted();
    const windowEnd = Math.min(windowStart + WINDOW_FRAMES, frameCount);
    const files = await Promise.all(
      Array.from({ length: windowEnd - windowStart }, (_, offset) =>
        skipped[windowStart + offset] === 1
          ? null
          : readFile(join(framesDir, frameFileName(windowStart + offset, frameExt))),
      ),
    );
    for (const [offset, file] of files.entries()) {
      const index = windowStart + offset;
      const at = index * FRAME_HASH_BYTES;
      const end = at + FRAME_HASH_BYTES;
      if (file === null) cachedHashes.copy(hashes, at, at, end);
      else createHash("sha256").update(file).digest().copy(hashes, at);
      if (index < cachedFrames && hashes.compare(cachedHashes, at, end, at, end) === 0) {
        identical[index] = 1;
      }
    }
  }
  return { runs: runsOf(identical), hashes };
}

/** One byte per frame, set for the frames in `skippedRuns`, which must all be below `limit`. */
function skippedFrameMask(skippedRuns: readonly FrameRun[], limit: number): Uint8Array {
  const mask = new Uint8Array(limit);
  for (const run of skippedRuns) {
    if (run.endFrame > limit) {
      throw new Error(
        `[frameDiff] no cached hash for skipped frames ${run.startFrame}-${run.endFrame}`,
      );
    }
    mask.fill(1, run.startFrame, run.endFrame);
  }
  return mask;
}

/** The runs of set bytes in `mask`, ascending. */
function runsOf(mask: Uint8Array): FrameRun[] {
  const runs: FrameRun[] = [];
  let runStart = -1;
  for (let index = 0; index <= mask.length; index++) {
    const set = mask[index] === 1;
    if (set && runStart < 0) runStart = index;
    if (!set && runStart >= 0) {
      runs.push({ startFrame: runStart, endFrame: index });
      runStart = -1;
    }
  }
  return runs;
}
