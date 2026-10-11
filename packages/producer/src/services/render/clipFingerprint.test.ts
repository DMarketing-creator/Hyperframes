import { describe, expect, it } from "vitest";
import { predictUnchangedRuns, type PageFingerprints } from "./clipFingerprint.js";

describe("predictUnchangedRuns", () => {
  const FPS = { num: 30, den: 1 };
  const scenes = (hashes: [string, string, string], global = "g"): PageFingerprints => ({
    global,
    clips: hashes.map((hash, index) => ({ start: index * 20, end: (index + 1) * 20, hash })),
  });
  const predict = (cached: PageFingerprints, current: PageFingerprints, totalFrames = 1800) =>
    predictUnchangedRuns({ cached, current, totalFrames, fps: FPS }).map((run) => [
      run.startFrame,
      run.endFrame,
    ]);

  it("predicts the whole timeline unchanged when nothing differs", () => {
    expect(predict(scenes(["a", "b", "c"]), scenes(["a", "b", "c"]))).toEqual([[0, 1800]]);
  });

  it("marks a changed clip's window, one frame wider on each side", () => {
    expect(predict(scenes(["a", "b", "c"]), scenes(["a", "B", "c"]))).toEqual([
      [0, 599],
      [1202, 1800],
    ]);
    expect(predict(scenes(["a", "b", "c"]), scenes(["a", "b", "C"]))).toEqual([[0, 1199]]);
  });

  it("predicts nothing unchanged when the global fingerprint differs", () => {
    expect(predict(scenes(["a", "b", "c"]), scenes(["a", "b", "c"], "other"))).toEqual([]);
  });

  it("marks both windows of a clip that moved", () => {
    const cached: PageFingerprints = { global: "g", clips: [{ start: 10, end: 20, hash: "a" }] };
    const current: PageFingerprints = { global: "g", clips: [{ start: 30, end: 40, hash: "a" }] };
    expect(predict(cached, current)).toEqual([
      [0, 299],
      [602, 899],
      [1202, 1800],
    ]);
  });

  it("marks the window of a clip that was added or removed", () => {
    const base: PageFingerprints = { global: "g", clips: [{ start: 0, end: 60, hash: "a" }] };
    const withOverlay: PageFingerprints = {
      global: "g",
      clips: [...base.clips, { start: 5, end: 10, hash: "o" }],
    };
    const expected = [
      [0, 149],
      [302, 1800],
    ];
    expect(predict(base, withOverlay)).toEqual(expected);
    expect(predict(withOverlay, base)).toEqual(expected);
  });

  it("counts identical clips, so a duplicate that disappears is a change", () => {
    const one: PageFingerprints = { global: "g", clips: [{ start: 0, end: 10, hash: "a" }] };
    const two: PageFingerprints = { global: "g", clips: [...one.clips, ...one.clips] };
    expect(predict(two, one)).toEqual([[302, 1800]]);
  });

  it("covers overlapping clips on several tracks: a frame needs every active clip unchanged", () => {
    const cached: PageFingerprints = {
      global: "g",
      clips: [
        { start: 0, end: 30, hash: "base" },
        { start: 10, end: 20, hash: "title" },
      ],
    };
    const current: PageFingerprints = {
      global: "g",
      clips: [
        { start: 0, end: 30, hash: "base" },
        { start: 10, end: 20, hash: "TITLE" },
      ],
    };
    expect(predict(cached, current, 900)).toEqual([
      [0, 299],
      [602, 900],
    ]);
  });

  it("predicts nothing unchanged when a differing clip has no numeric window", () => {
    const cached: PageFingerprints = { global: "g", clips: [{ start: 0, end: 10, hash: "a" }] };
    const current: PageFingerprints = {
      global: "g",
      clips: [{ start: 0, end: Number.NaN, hash: "a" }],
    };
    expect(predict(cached, current)).toEqual([]);
  });

  it("uses the frame rate to place a window", () => {
    const fps = { num: 30000, den: 1001 };
    const cached: PageFingerprints = { global: "g", clips: [{ start: 1, end: 2, hash: "a" }] };
    const current: PageFingerprints = { global: "g", clips: [{ start: 1, end: 2, hash: "b" }] };
    expect(predictUnchangedRuns({ cached, current, totalFrames: 120, fps })).toEqual([
      { startFrame: 0, endFrame: 28 },
      { startFrame: 62, endFrame: 120 },
    ]);
  });
});
