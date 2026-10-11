import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureRunsFor,
  isCaptureSkipEnabled,
  moveCapturedRun,
  planFromFingerprints,
  planSkippedRuns,
  probeFramesFor,
  verifySkippedRuns,
} from "./captureSkip.js";
import type { ClipFingerprints } from "./clipFingerprint.js";

const FPS = { num: 30, den: 1 };
const scenes = (hashes: [string, string, string]): ClipFingerprints => ({
  global: "g",
  clips: hashes.map((hash, index) => ({ start: index * 20, end: (index + 1) * 20, hash })),
  probes: [],
});

describe("planSkippedRuns", () => {
  const cached = (clips: ClipFingerprints | null, totalFrames = 1800, gopSize = 30) => ({
    totalFrames,
    settings: { fps: "30/1", gopSize },
    clips,
  });
  const plan = (
    cachedRender: ReturnType<typeof cached>,
    current: ClipFingerprints,
    totalFrames = 1800,
  ) =>
    planSkippedRuns({ cached: cachedRender, current, totalFrames, fps: FPS }).map((run) => [
      run.startFrame,
      run.endFrame,
    ]);

  it("skips the whole timeline when nothing changed", () => {
    expect(plan(cached(scenes(["a", "b", "c"])), scenes(["a", "b", "c"]))).toEqual([[0, 1800]]);
  });

  it("skips whole GOPs around a changed clip", () => {
    // Unchanged frames are 0-599 and 1202-1800; only complete one-second GOPs are skipped.
    expect(plan(cached(scenes(["a", "b", "c"])), scenes(["a", "B", "c"]))).toEqual([
      [0, 570],
      [1230, 1800],
    ]);
  });

  it("follows the cached render's GOP size", () => {
    expect(plan(cached(scenes(["a", "b", "c"]), 1800, 600), scenes(["a", "b", "C"]))).toEqual([
      [0, 600],
    ]);
  });

  it("does not skip an unchanged section shorter than the minimum reuse length", () => {
    const base: ClipFingerprints = {
      global: "g",
      clips: [
        { start: 0, end: 1.5, hash: "a" },
        { start: 1.5, end: 10, hash: "b" },
      ],
      probes: [],
    };
    const edited: ClipFingerprints = {
      ...base,
      clips: [base.clips[0] ?? { start: 0, end: 0, hash: "" }, { start: 1.5, end: 10, hash: "B" }],
    };
    expect(plan(cached(base, 300), edited, 300)).toEqual([]);
  });

  it("skips nothing without cached fingerprints or at another frame rate", () => {
    expect(plan(cached(null), scenes(["a", "b", "c"]))).toEqual([]);
    const other = { ...cached(scenes(["a", "b", "c"])), settings: { fps: "60/1", gopSize: 60 } };
    expect(plan(other, scenes(["a", "b", "c"]))).toEqual([]);
  });

  it("captures the tail when the composition grew", () => {
    expect(plan(cached(scenes(["a", "b", "c"]), 1800), scenes(["a", "b", "c"]), 1900)).toEqual([
      [0, 1800],
    ]);
  });
});

describe("captureRunsFor", () => {
  it("is the rest of the timeline, in order", () => {
    expect(
      captureRunsFor(
        [
          { startFrame: 0, endFrame: 570 },
          { startFrame: 1230, endFrame: 1800 },
        ],
        1800,
      ),
    ).toEqual([{ startFrame: 570, endFrame: 1230 }]);
    expect(captureRunsFor([{ startFrame: 600, endFrame: 1200 }], 1800)).toEqual([
      { startFrame: 0, endFrame: 600 },
      { startFrame: 1200, endFrame: 1800 },
    ]);
  });

  it("is everything when nothing is skipped, and nothing when everything is", () => {
    expect(captureRunsFor([], 90)).toEqual([{ startFrame: 0, endFrame: 90 }]);
    expect(captureRunsFor([{ startFrame: 0, endFrame: 90 }], 90)).toEqual([]);
  });
});

describe("probeFramesFor", () => {
  it("puts one probe in every section long enough to be reused", () => {
    const frames = probeFramesFor(1800, FPS);
    expect(frames).toHaveLength(30);
    expect(frames.slice(0, 3)).toEqual([30, 90, 150]);
    expect(frames.at(-1)).toBe(1770);
    for (let start = 0; start + 60 <= 1800; start += 30) {
      expect(frames.some((frame) => frame >= start && frame < start + 60)).toBe(true);
    }
  });

  it("spreads a fixed number of probes over a long render", () => {
    const frames = probeFramesFor(18000, FPS);
    expect(frames).toHaveLength(32);
    expect(frames.slice(0, 2)).toEqual([281, 844]);
  });

  it("probes a render shorter than one section, and nothing of an empty one", () => {
    expect(probeFramesFor(20, FPS)).toEqual([0]);
    expect(probeFramesFor(45, FPS)).toEqual([30]);
    expect(probeFramesFor(0, FPS)).toEqual([]);
  });
});

describe("verifySkippedRuns", () => {
  const probes = (hashes: Record<number, string>) =>
    Object.entries(hashes).map(([frame, hash]) => ({ frame: Number(frame), hash }));
  const first = { startFrame: 0, endFrame: 570 };
  const last = { startFrame: 1230, endFrame: 1800 };

  it("keeps the runs whose probes all match", () => {
    const cached = probes({ 30: "a", 510: "b", 900: "c", 1290: "d", 1770: "e" });
    const current = probes({ 30: "a", 510: "b", 900: "C", 1290: "d", 1770: "E" });
    expect(verifySkippedRuns({ planned: [first, last], cached, current })).toEqual({
      verified: [first],
      mismatches: [{ run: last, frame: 1770 }],
    });
  });

  it("does not verify a run that holds no probe", () => {
    const all = probes({ 30: "a" });
    expect(verifySkippedRuns({ planned: [last], cached: all, current: all })).toEqual({
      verified: [],
      mismatches: [{ run: last, frame: null }],
    });
  });

  it("does not verify a run whose probe the cached render did not take", () => {
    expect(
      verifySkippedRuns({
        planned: [first],
        cached: probes({ 60: "a" }),
        current: probes({ 30: "a" }),
      }),
    ).toEqual({ verified: [], mismatches: [{ run: first, frame: 30 }] });
  });
});

describe("planFromFingerprints", () => {
  const messages: unknown[] = [];
  const log = { info: (_message: string, meta?: unknown) => void messages.push(meta) };
  const probed = (hashes: [string, string, string], probe: string): ClipFingerprints => ({
    ...scenes(hashes),
    probes: [
      { frame: 30, hash: "p1" },
      { frame: 1770, hash: probe },
    ],
  });
  const cachedRender = (clips: ClipFingerprints | null) => ({
    totalFrames: 1800,
    settings: { fps: "30/1", gopSize: 30 },
    clips,
  });
  const plan = (cached: ReturnType<typeof cachedRender> | null, clips: ClipFingerprints) =>
    planFromFingerprints({ cached, clips, totalFrames: 1800, fps: FPS, log });

  it("captures everything, and says why, when the cache has nothing to compare", () => {
    const clips = probed(["a", "b", "c"], "p2");
    const everything = [{ startFrame: 0, endFrame: 1800 }];
    expect(plan(null, clips)).toEqual({
      clips,
      skippedRuns: [],
      captureRuns: everything,
      reason: "no cached render",
      probedFrames: 2,
    });
    expect(plan(cachedRender(null), clips).reason).toBe("cached render has no fingerprints");
    expect(plan(cachedRender(probed(["x", "y", "z"], "p2")), clips).reason).toBe(
      "no unchanged section",
    );
  });

  it("skips the runs the probes confirm and captures the rest", () => {
    const clips = probed(["a", "B", "c"], "p2");
    expect(plan(cachedRender(probed(["a", "b", "c"], "p2")), clips)).toEqual({
      clips,
      skippedRuns: [
        { startFrame: 0, endFrame: 570 },
        { startFrame: 1230, endFrame: 1800 },
      ],
      captureRuns: [{ startFrame: 570, endFrame: 1230 }],
      probedFrames: 2,
    });
  });

  it("captures a run whose probe changed although its fingerprint did not", () => {
    messages.length = 0;
    const clips = probed(["a", "B", "c"], "changed");
    const planned = plan(cachedRender(probed(["a", "b", "c"], "p2")), clips);
    expect(planned.skippedRuns).toEqual([{ startFrame: 0, endFrame: 570 }]);
    expect(planned.captureRuns).toEqual([{ startFrame: 570, endFrame: 1800 }]);
    expect(messages).toEqual([{ run: "1230-1800", frame: 1770 }]);
    const none = plan(cachedRender(probed(["a", "b", "c"], "p2")), {
      ...clips,
      probes: [{ frame: 1770, hash: "changed" }],
    });
    expect(none.reason).toBe("probe frames differ");
    expect(none.skippedRuns).toEqual([]);
  });
});

describe("moveCapturedRun", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("renames a run's files from run-relative to timeline frame numbers", () => {
    const runDir = mkdtempSync(join(tmpdir(), "hf-run-"));
    const framesDir = mkdtempSync(join(tmpdir(), "hf-frames-"));
    dirs.push(runDir, framesDir);
    for (const index of [0, 1, 2]) {
      writeFileSync(join(runDir, `frame_00000${index}.jpg`), `frame ${index}`);
    }
    moveCapturedRun(runDir, framesDir, { startFrame: 570, endFrame: 573 }, "jpg");
    expect(readdirSync(runDir)).toEqual([]);
    expect(readdirSync(framesDir).sort()).toEqual([
      "frame_000570.jpg",
      "frame_000571.jpg",
      "frame_000572.jpg",
    ]);
    expect(readFileSync(join(framesDir, "frame_000572.jpg"), "utf-8")).toBe("frame 2");
  });
});

describe("isCaptureSkipEnabled", () => {
  it("is on unless switched off", () => {
    expect(isCaptureSkipEnabled({})).toBe(true);
    expect(isCaptureSkipEnabled({ HF_FRAME_CACHE_SKIP_CAPTURE: "true" })).toBe(true);
    expect(isCaptureSkipEnabled({ HF_FRAME_CACHE_SKIP_CAPTURE: "false" })).toBe(false);
    expect(isCaptureSkipEnabled({ HF_FRAME_CACHE_SKIP_CAPTURE: " OFF " })).toBe(false);
  });
});
