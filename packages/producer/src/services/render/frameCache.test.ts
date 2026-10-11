import { describe, expect, it } from "vitest";
import {
  formatFrameCacheSegment,
  frameCacheEncodeConcurrency,
  frameCacheGopSize,
  frameCacheMinReuseFrames,
  frameCacheSettings,
  isFrameCacheEnabled,
  planFrameCacheSegments,
} from "./frameCache.js";

describe("planFrameCacheSegments", () => {
  const FPS = { num: 30, den: 1 };
  /** The segment map as `[status, startFrame, endFrame]` rows. */
  const plan = (
    totalFrames: number,
    cachedFrames: number,
    identical: [number, number][],
    options: { gopSize?: number; minReuseFrames?: number } = {},
  ) =>
    planFrameCacheSegments({
      totalFrames,
      cachedFrames,
      identicalRuns: identical.map(([startFrame, endFrame]) => ({ startFrame, endFrame })),
      gopSize: options.gopSize ?? 30,
      fps: FPS,
      minReuseFrames: options.minReuseFrames,
    }).map((segment) => [segment.status, segment.startFrame, segment.endFrame]);

  it("is a single render segment when there is no cached render", () => {
    expect(plan(100, 0, [])).toEqual([["render", 0, 100]]);
  });

  it("is a single reuse segment when every frame is identical", () => {
    expect(plan(100, 100, [[0, 100]])).toEqual([["reuse", 0, 100]]);
    // A whole-timeline reuse is kept however short it is.
    expect(plan(20, 20, [[0, 20]], { minReuseFrames: 60 })).toEqual([["reuse", 0, 20]]);
  });

  it("renders only the GOPs that hold a changed frame", () => {
    expect(
      plan(100, 100, [
        [0, 37],
        [52, 100],
      ]),
    ).toEqual([
      ["reuse", 0, 30],
      ["render", 30, 60],
      ["reuse", 60, 100],
    ]);
  });

  it("maps several identical sections across the timeline, with timestamps", () => {
    // 12 minutes: 0-2 identical, 2-5 changed, 5-8 identical, 8-9 changed, 9-12 identical.
    const minute = 60 * 30;
    const segments = planFrameCacheSegments({
      totalFrames: 12 * minute,
      cachedFrames: 12 * minute,
      identicalRuns: [
        { startFrame: 0, endFrame: 2 * minute },
        { startFrame: 5 * minute, endFrame: 8 * minute },
        { startFrame: 9 * minute, endFrame: 12 * minute },
      ],
      gopSize: 30,
      fps: FPS,
      minReuseFrames: 60,
    });
    expect(segments.map(formatFrameCacheSegment)).toEqual([
      "reuse 00:00-02:00 (frames 0-3600)",
      "render 02:00-05:00 (frames 3600-9000)",
      "reuse 05:00-08:00 (frames 9000-14400)",
      "render 08:00-09:00 (frames 14400-16200)",
      "reuse 09:00-12:00 (frames 16200-21600)",
    ]);
    expect(segments[1]).toMatchObject({ startSeconds: 120, endSeconds: 300 });
  });

  it("covers the timeline with no gaps or overlaps", () => {
    const segments = plan(
      1000,
      940,
      [
        [3, 200],
        [260, 261],
        [300, 655],
        [700, 940],
      ],
      { minReuseFrames: 60 },
    );
    expect(segments[0]?.[1]).toBe(0);
    expect(segments[segments.length - 1]?.[2]).toBe(1000);
    for (const [index, segment] of segments.entries()) {
      expect(segment[2]).toBeGreaterThan(Number(segment[1]));
      if (index > 0) {
        expect(segment[1]).toBe(segments[index - 1]?.[2]);
        expect(segment[0]).not.toBe(segments[index - 1]?.[0]);
      }
    }
  });

  it("renders an identical run too short to be worth splitting for", () => {
    const identical: [number, number][] = [
      [30, 60],
      [90, 300],
    ];
    expect(plan(300, 300, identical)).toEqual([
      ["render", 0, 30],
      ["reuse", 30, 60],
      ["render", 60, 90],
      ["reuse", 90, 300],
    ]);
    expect(plan(300, 300, identical, { minReuseFrames: 60 })).toEqual([
      ["render", 0, 90],
      ["reuse", 90, 300],
    ]);
    // Short runs at either end of the timeline are merged too.
    expect(
      plan(
        300,
        300,
        [
          [0, 30],
          [270, 300],
        ],
        { minReuseFrames: 60 },
      ),
    ).toEqual([["render", 0, 300]]);
  });

  it("renders frames beyond the cached length, and the GOP they extend", () => {
    expect(plan(130, 100, [[0, 100]])).toEqual([
      ["reuse", 0, 90],
      ["render", 90, 130],
    ]);
    expect(plan(120, 90, [[0, 90]])).toEqual([
      ["reuse", 0, 90],
      ["render", 90, 120],
    ]);
  });

  it("drops cached frames beyond the new length", () => {
    expect(plan(60, 100, [[0, 60]])).toEqual([["reuse", 0, 60]]);
    // A GOP cut short cannot be stream-copied up to a non-keyframe.
    expect(plan(70, 100, [[0, 70]])).toEqual([
      ["reuse", 0, 60],
      ["render", 60, 70],
    ]);
  });

  it("treats every frame as its own GOP at gopSize 1", () => {
    expect(
      plan(
        5,
        5,
        [
          [0, 2],
          [3, 5],
        ],
        { gopSize: 1 },
      ),
    ).toEqual([
      ["reuse", 0, 2],
      ["render", 2, 3],
      ["reuse", 3, 5],
    ]);
  });

  it("formats sub-second and hour-long timestamps", () => {
    const [segment] = planFrameCacheSegments({
      totalFrames: 108045,
      cachedFrames: 0,
      identicalRuns: [],
      gopSize: 30,
      fps: FPS,
    });
    expect(segment && formatFrameCacheSegment(segment)).toBe(
      "render 00:00-01:00:01.500 (frames 0-108045)",
    );
  });
});

describe("frame cache settings", () => {
  const base = {
    fps: { num: 30, den: 1 },
    format: "mp4",
    imageFormat: "jpg" as const,
    gopSize: 30,
    encoder: {
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      codec: "h264" as const,
      quality: 23,
    },
  };
  const key = (input: typeof base) => JSON.stringify(frameCacheSettings(input));

  it("changes with fps, resolution, codec, quality and format", () => {
    const original = key(base);
    expect(key({ ...base })).toBe(original);
    expect(key({ ...base, fps: { num: 60, den: 1 } })).not.toBe(original);
    expect(key({ ...base, format: "mov" })).not.toBe(original);
    expect(key({ ...base, encoder: { ...base.encoder, width: 1280 } })).not.toBe(original);
    expect(key({ ...base, encoder: { ...base.encoder, codec: "h265" } })).not.toBe(original);
    expect(key({ ...base, encoder: { ...base.encoder, quality: 18 } })).not.toBe(original);
  });

  it("uses a one-second GOP, and single-frame GOPs for intra-only ProRes", () => {
    expect(frameCacheGopSize("h264", { num: 30000, den: 1001 })).toBe(30);
    expect(frameCacheGopSize("vp9", { num: 24, den: 1 })).toBe(24);
    expect(frameCacheGopSize("prores", { num: 30, den: 1 })).toBe(1);
  });

  it("encodes two render segments at once unless --workers says otherwise", () => {
    expect(frameCacheEncodeConcurrency(undefined)).toBe(2);
    expect(frameCacheEncodeConcurrency(1)).toBe(1);
    expect(frameCacheEncodeConcurrency(4)).toBe(4);
  });

  it("needs two seconds of identical frames before reusing a run", () => {
    expect(frameCacheMinReuseFrames({ num: 30, den: 1 })).toBe(60);
    expect(frameCacheMinReuseFrames({ num: 24000, den: 1001 })).toBe(48);
  });

  it("is on unless HF_FRAME_CACHE turns it off", () => {
    expect(isFrameCacheEnabled({})).toBe(true);
    expect(isFrameCacheEnabled({ HF_FRAME_CACHE: "true" })).toBe(true);
    expect(isFrameCacheEnabled({ HF_FRAME_CACHE: "false" })).toBe(false);
    expect(isFrameCacheEnabled({ HF_FRAME_CACHE: "0" })).toBe(false);
  });
});
