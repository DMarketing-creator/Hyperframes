/**
 * The frame cache against real FFmpeg and the real frame diff: what a mocked
 * test cannot see is whether a video stitched from cached and re-encoded
 * segments still holds exactly the right frames in the right order.
 *
 * Needs ffmpeg, so it lives in the integration lane
 * (`scripts/test-classification.mjs`).
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getFfmpegBinary, type EncoderOptions } from "@hyperframes/engine";
import type { ClipFingerprints } from "./clipFingerprint.js";
import { FRAME_HASH_BYTES, findIdenticalFrameRuns, type FrameRun } from "./frameDiff.js";
import {
  encodeWithFrameCache,
  FrameCacheSkipError,
  frameCacheSettings,
  readCachedRender,
  type FrameCacheEncodeResult,
} from "./frameCache.js";

const FFMPEG = getFfmpegBinary();
const HAS_TOOLS = spawnSync(FFMPEG, ["-version"]).status === 0;

const FPS = { num: 30, den: 1 };
const GOP = 30;
const FRAMES = 100;
const log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

function ffmpeg(args: string[]): string {
  const result = spawnSync(FFMPEG, ["-y", "-v", "error", ...args], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

/** One md5 per decoded frame, in presentation order. */
function decodedFrameHashes(videoPath: string): string[] {
  return ffmpeg(["-i", videoPath, "-f", "framemd5", "-"])
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split(",").pop()?.trim() ?? "");
}

function frameName(index: number): string {
  return `frame_${String(index).padStart(6, "0")}.jpg`;
}

describe.skipIf(!HAS_TOOLS)("frame cache (ffmpeg)", () => {
  let root: string;
  let source: string;
  let altered: string;
  let renderCount = 0;

  const encoder: EncoderOptions = {
    fps: FPS,
    width: 160,
    height: 120,
    codec: "h264",
    preset: "ultrafast",
    quality: 28,
    pixelFormat: "yuv420p",
    lockGopForChunkConcat: true,
    gopSize: GOP,
  };

  /** Lay out `count` frames, taking the listed ranges from the altered set. */
  function framesDirWith(count: number, alteredRanges: [number, number][] = []): string {
    const dir = mkdtempSync(join(root, "frames-"));
    for (let index = 0; index < count; index++) {
      const isAltered = alteredRanges.some(([start, end]) => index >= start && index < end);
      copyFileSync(
        join(isAltered ? altered : source, frameName(index)),
        join(dir, frameName(index)),
      );
    }
    return dir;
  }

  async function render(
    cacheDir: string,
    framesDir: string,
    {
      quality = 28,
      minReuseFrames = GOP,
      maxParallelEncodes = undefined as number | undefined,
      totalFrames = undefined as number | undefined,
      skippedRuns = undefined as FrameRun[] | undefined,
      clips = undefined as ClipFingerprints | null | undefined,
    } = {},
  ): Promise<{ result: FrameCacheEncodeResult; hashes: string[] }> {
    const workDir = join(root, `work-${renderCount++}`);
    mkdirSync(workDir);
    const videoOnlyPath = join(workDir, "video-only.mp4");
    const options = { ...encoder, quality };
    const result = await encodeWithFrameCache({
      cacheDir,
      framesDir,
      frameExt: "jpg",
      videoOnlyPath,
      settings: frameCacheSettings({
        fps: FPS,
        format: "mp4",
        imageFormat: "jpg",
        gopSize: GOP,
        encoder: options,
      }),
      encoder: options,
      minReuseFrames,
      maxParallelEncodes,
      totalFrames,
      skippedRuns,
      clips,
      ffmpegTimeout: 60_000,
      log,
    });
    return { result, hashes: decodedFrameHashes(videoOnlyPath) };
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "hf-frame-cache-"));
    source = join(root, "source");
    altered = join(root, "altered");
    mkdirSync(source);
    mkdirSync(altered);
    const input = ["-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30", "-frames:v", "130"];
    ffmpeg([...input, "-start_number", "0", join(source, "frame_%06d.jpg")]);
    ffmpeg([...input, "-vf", "negate", "-start_number", "0", join(altered, "frame_%06d.jpg")]);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The segment map as `[status, startFrame, endFrame]` rows. */
  const rows = (result: FrameCacheEncodeResult) =>
    result.segments.map((segment) => [segment.status, segment.startFrame, segment.endFrame]);

  type Rendered = Awaited<ReturnType<typeof render>>;
  /**
   * `second` rendered the GOP at frames 30-60 and took the rest from the cache
   * `first` left: reused frames are the cached video's frames, bit for bit.
   */
  const expectMiddleGopRendered = (first: Rendered, second: Rendered): void => {
    expect(rows(second.result)).toEqual([
      ["reuse", 0, 30],
      ["render", 30, 60],
      ["reuse", 60, FRAMES],
    ]);
    expect(second.hashes).toHaveLength(FRAMES);
    expect(second.hashes.slice(0, 30)).toEqual(first.hashes.slice(0, 30));
    expect(second.hashes.slice(60)).toEqual(first.hashes.slice(60));
  };

  /** Hashes of the first `count` frames of a directory, as the cache stores them. */
  async function hashesOf(framesDir: string, count: number): Promise<Buffer> {
    const { hashes } = await findIdenticalFrameRuns({
      framesDir,
      frameExt: "jpg",
      frameCount: count,
      cachedHashes: Buffer.alloc(0),
    });
    return hashes;
  }

  it("finds every identical run on the timeline, treating a frame past the cached length as changed", async () => {
    const current = framesDirWith(50, [
      [3, 5],
      [20, 21],
    ]);
    const { runs, hashes } = await findIdenticalFrameRuns({
      framesDir: current,
      frameExt: "jpg",
      frameCount: 42,
      cachedHashes: await hashesOf(framesDirWith(40), 40),
    });
    expect(runs).toEqual([
      { startFrame: 0, endFrame: 3 },
      { startFrame: 5, endFrame: 20 },
      { startFrame: 21, endFrame: 40 },
    ]);
    expect(hashes).toHaveLength(42 * FRAME_HASH_BYTES);
    expect(hashes.equals(await hashesOf(current, 42))).toBe(true);
  });

  it("treats a frame as changed when any single byte of its file differs", async () => {
    const current = framesDirWith(4);
    const cachedHashes = await hashesOf(current, 4);
    const flipByteAt = (index: number, position: (length: number) => number) => {
      const path = join(current, frameName(index));
      const bytes = readFileSync(path);
      const at = position(bytes.length);
      bytes[at] = (bytes[at] ?? 0) ^ 1;
      writeFileSync(path, bytes);
    };
    flipByteAt(0, () => 0);
    flipByteAt(1, (length) => Math.floor(length / 2));
    flipByteAt(3, (length) => length - 1);
    const { runs } = await findIdenticalFrameRuns({
      framesDir: current,
      frameExt: "jpg",
      frameCount: 4,
      cachedHashes,
    });
    expect(runs).toEqual([{ startFrame: 2, endFrame: 3 }]);
  });

  it("re-encodes only the changed GOPs and keeps every other frame from the cache", async () => {
    const cacheDir = join(root, "cache-a");
    const first = await render(cacheDir, framesDirWith(FRAMES));
    expect(first.result).toMatchObject({ status: "no-cache", framesEncoded: 100, framesReused: 0 });
    expect(first.hashes).toHaveLength(FRAMES);

    const second = await render(cacheDir, framesDirWith(FRAMES, [[37, 52]]));
    expect(second.result).toMatchObject({ status: "hit", framesEncoded: 30, framesReused: 70 });
    expectMiddleGopRendered(first, second);
    expect(second.hashes.slice(37, 52)).not.toEqual(first.hashes.slice(37, 52));

    // The cache now holds the second render: repeating it encodes nothing.
    const third = await render(cacheDir, framesDirWith(FRAMES, [[37, 52]]));
    expect(third.result).toMatchObject({ status: "hit", framesEncoded: 0, framesReused: 100 });
    expect(third.hashes).toEqual(second.hashes);
  });

  it("renders several changed sections and merges all segments in order", async () => {
    const cacheDir = join(root, "cache-d");
    const first = await render(cacheDir, framesDirWith(130));
    const edits: [number, number][] = [
      [5, 6],
      [65, 66],
      [125, 126],
    ];
    const second = await render(cacheDir, framesDirWith(130, edits));
    expect(rows(second.result)).toEqual([
      ["render", 0, 30],
      ["reuse", 30, 60],
      ["render", 60, 90],
      ["reuse", 90, 120],
      ["render", 120, 130],
    ]);
    expect(second.result).toMatchObject({ framesEncoded: 70, framesReused: 60 });
    expect(second.hashes).toHaveLength(130);
    expect(second.hashes.slice(30, 60)).toEqual(first.hashes.slice(30, 60));
    expect(second.hashes.slice(90, 120)).toEqual(first.hashes.slice(90, 120));
    for (const [frame] of edits) expect(second.hashes[frame]).not.toBe(first.hashes[frame]);
  });

  it("produces the same video whether segments are encoded one at a time or together", async () => {
    const edits: [number, number][] = [
      [5, 6],
      [65, 66],
      [125, 126],
    ];
    const hashes: string[][] = [];
    for (const maxParallelEncodes of [1, 3]) {
      const cacheDir = join(root, `cache-parallel-${maxParallelEncodes}`);
      await render(cacheDir, framesDirWith(130));
      const second = await render(cacheDir, framesDirWith(130, edits), { maxParallelEncodes });
      expect(second.result.segments).toHaveLength(5);
      hashes.push(second.hashes);
    }
    expect(hashes[1]).toEqual(hashes[0]);
  });

  it("renders an identical run that is too short to be worth a split", async () => {
    const cacheDir = join(root, "cache-f");
    const first = await render(cacheDir, framesDirWith(130));
    const second = await render(
      cacheDir,
      framesDirWith(130, [
        [5, 6],
        [65, 66],
      ]),
      { minReuseFrames: 40 },
    );
    expect(rows(second.result)).toEqual([
      ["render", 0, 90],
      ["reuse", 90, 130],
    ]);
    expect(second.hashes).toHaveLength(130);
    expect(second.hashes.slice(90)).toEqual(first.hashes.slice(90));
  });

  it("encodes added frames and drops removed ones when the frame count changes", async () => {
    const cacheDir = join(root, "cache-b");
    const first = await render(cacheDir, framesDirWith(FRAMES));

    const longer = await render(cacheDir, framesDirWith(130));
    expect(longer.result).toMatchObject({ status: "hit", framesEncoded: 40, framesReused: 90 });
    expect(longer.hashes).toHaveLength(130);
    expect(longer.hashes.slice(0, 90)).toEqual(first.hashes.slice(0, 90));

    const shorter = await render(cacheDir, framesDirWith(60));
    expect(shorter.result).toMatchObject({ status: "hit", framesEncoded: 0, framesReused: 60 });
    expect(shorter.hashes).toEqual(first.hashes.slice(0, 60));
    expect(statSync(join(cacheDir, "hashes.bin")).size).toBe(60 * FRAME_HASH_BYTES);
  });

  it("stores one hash per frame, and discards a cache in an older layout", async () => {
    const cacheDir = join(root, "cache-old");
    const framesDir = framesDirWith(60);
    // A version 1 cache: full frame images under frames/.
    mkdirSync(join(cacheDir, "frames"), { recursive: true });
    copyFileSync(join(framesDir, frameName(0)), join(cacheDir, "frames", frameName(0)));
    writeFileSync(join(cacheDir, "video.mp4"), "not a video");
    writeFileSync(
      join(cacheDir, "manifest.json"),
      JSON.stringify({ version: 1, settings: {}, totalFrames: 60, videoFile: "video.mp4" }),
    );

    const first = await render(cacheDir, framesDir);
    expect(first.result).toMatchObject({ status: "no-cache", framesEncoded: 60 });
    expect(readdirSync(cacheDir).sort()).toEqual(["hashes.bin", "manifest.json", "video.mp4"]);
    expect(JSON.parse(readFileSync(join(cacheDir, "manifest.json"), "utf-8")).version).toBe(4);
    expect(statSync(join(cacheDir, "hashes.bin")).size).toBe(60 * FRAME_HASH_BYTES);

    const second = await render(cacheDir, framesDir);
    expect(second.result).toMatchObject({ status: "hit", framesReused: 60 });
  });

  it("starts over when the hash file does not match the manifest", async () => {
    const cacheDir = join(root, "cache-truncated");
    const framesDir = framesDirWith(60);
    await render(cacheDir, framesDir);
    writeFileSync(join(cacheDir, "hashes.bin"), Buffer.alloc(10));
    const again = await render(cacheDir, framesDir);
    expect(again.result).toMatchObject({ status: "no-cache", framesEncoded: 60 });
  });

  /** A frame directory holding only the listed runs, taken from the altered set. */
  function partialFramesDir(captured: [number, number][]): string {
    const dir = mkdtempSync(join(root, "frames-"));
    for (const [start, end] of captured) {
      for (let index = start; index < end; index++) {
        copyFileSync(join(altered, frameName(index)), join(dir, frameName(index)));
      }
    }
    return dir;
  }

  it("reuses skipped runs that have no frame files", async () => {
    const cacheDir = join(root, "cache-skip");
    const first = await render(cacheDir, framesDirWith(FRAMES));
    const second = await render(cacheDir, partialFramesDir([[30, 60]]), {
      totalFrames: FRAMES,
      skippedRuns: [
        { startFrame: 0, endFrame: 30 },
        { startFrame: 60, endFrame: FRAMES },
      ],
    });
    expectMiddleGopRendered(first, second);
    expect(second.result).toMatchObject({ framesEncoded: 30, framesNotCaptured: 70 });
    expect(second.hashes.slice(30, 60)).not.toEqual(first.hashes.slice(30, 60));

    // The skipped frames keep their cached hash, so the next full capture
    // still finds them identical.
    const third = await render(cacheDir, framesDirWith(FRAMES, [[30, 60]]));
    expect(third.result).toMatchObject({ status: "hit", framesEncoded: 0, framesReused: FRAMES });
  });

  it("copies the cached video when every frame was skipped", async () => {
    const cacheDir = join(root, "cache-skip-all");
    const first = await render(cacheDir, framesDirWith(60));
    const second = await render(cacheDir, partialFramesDir([]), {
      totalFrames: 60,
      skippedRuns: [{ startFrame: 0, endFrame: 60 }],
    });
    expect(second.result).toMatchObject({ framesEncoded: 0, framesNotCaptured: 60 });
    expect(second.hashes).toEqual(first.hashes);
  });

  it("refuses skipped frames it cannot supply, leaving the cache as it was", async () => {
    const skipAll = { totalFrames: 60, skippedRuns: [{ startFrame: 0, endFrame: 60 }] };
    const empty = partialFramesDir([]);
    // No cached render at all.
    await expect(render(join(root, "cache-skip-none"), empty, skipAll)).rejects.toBeInstanceOf(
      FrameCacheSkipError,
    );

    const cacheDir = join(root, "cache-skip-refused");
    await render(cacheDir, framesDirWith(60));
    const before = readFileSync(join(cacheDir, "manifest.json"), "utf-8");
    // Cached with other encode settings.
    await expect(render(cacheDir, empty, { ...skipAll, quality: 20 })).rejects.toBeInstanceOf(
      FrameCacheSkipError,
    );
    // A skipped run that does not sit on the cached video's keyframes.
    await expect(
      render(cacheDir, partialFramesDir([[45, 60]]), {
        totalFrames: 60,
        skippedRuns: [{ startFrame: 0, endFrame: 45 }],
      }),
    ).rejects.toBeInstanceOf(FrameCacheSkipError);
    // Skipped frames past the end of the cached render.
    await expect(
      render(cacheDir, empty, { totalFrames: 90, skippedRuns: [{ startFrame: 0, endFrame: 90 }] }),
    ).rejects.toThrow();
    expect(readFileSync(join(cacheDir, "manifest.json"), "utf-8")).toBe(before);
  });

  it("keeps the clip fingerprints of the latest render", async () => {
    const cacheDir = join(root, "cache-clips");
    const clips: ClipFingerprints = {
      global: "g1",
      clips: [{ start: 0, end: 2, hash: "a" }],
      probes: [{ frame: 30, hash: "p" }],
    };
    await render(cacheDir, framesDirWith(60));
    expect(readCachedRender(cacheDir)).toMatchObject({
      totalFrames: 60,
      settings: { fps: "30/1", gopSize: GOP },
      clips: null,
    });
    // Nothing changed: only the fingerprints are new.
    await render(cacheDir, framesDirWith(60), { clips });
    expect(readCachedRender(cacheDir)?.clips).toEqual(clips);
    const edited: ClipFingerprints = { ...clips, global: "g2" };
    await render(cacheDir, framesDirWith(60, [[0, 30]]), { clips: edited });
    expect(readCachedRender(cacheDir)?.clips).toEqual(edited);
  });

  it("ignores the cache when the encode settings differ", async () => {
    const cacheDir = join(root, "cache-c");
    await render(cacheDir, framesDirWith(60));
    const requality = await render(cacheDir, framesDirWith(60), { quality: 20 });
    expect(requality.result).toMatchObject({
      status: "settings-changed",
      framesEncoded: 60,
      framesReused: 0,
    });
    const again = await render(cacheDir, framesDirWith(60), { quality: 20 });
    expect(again.result).toMatchObject({ status: "hit", framesEncoded: 0, framesReused: 60 });
  });
});
