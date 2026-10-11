import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FRAME_HASH_BYTES, findIdenticalFrameRuns } from "./frameDiff.js";

describe("findIdenticalFrameRuns", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const hashOf = (content: string): Buffer => createHash("sha256").update(content).digest();
  /** A frame directory holding `contents[i]` as frame `i`; `null` leaves the file out. */
  const framesDirWith = (contents: readonly (string | null)[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "hf-frame-diff-"));
    dirs.push(dir);
    for (const [index, content] of contents.entries()) {
      if (content === null) continue;
      writeFileSync(join(dir, `frame_${String(index).padStart(6, "0")}.jpg`), content);
    }
    return dir;
  };
  const hashesOf = (contents: readonly string[]): Buffer => Buffer.concat(contents.map(hashOf));
  const frames = (count: number, edit: (index: number) => string = (index) => `frame ${index}`) =>
    Array.from({ length: count }, (_, index) => edit(index));

  it("finds every identical run, across the read window", async () => {
    const cached = frames(100);
    const current = frames(100, (index) =>
      index >= 40 && index < 70 ? `new ${index}` : `frame ${index}`,
    );
    const { runs, hashes } = await findIdenticalFrameRuns({
      framesDir: framesDirWith(current),
      frameExt: "jpg",
      frameCount: 100,
      cachedHashes: hashesOf(cached),
    });
    expect(runs).toEqual([
      { startFrame: 0, endFrame: 40 },
      { startFrame: 70, endFrame: 100 },
    ]);
    expect(hashes.equals(hashesOf(current))).toBe(true);
  });

  it("treats frames past the cached render as changed", async () => {
    const { runs } = await findIdenticalFrameRuns({
      framesDir: framesDirWith(frames(50)),
      frameExt: "jpg",
      frameCount: 50,
      cachedHashes: hashesOf(frames(30)),
    });
    expect(runs).toEqual([{ startFrame: 0, endFrame: 30 }]);
  });

  it("takes skipped frames from the cache without reading a file", async () => {
    const cached = frames(90);
    const current = frames(90, (index) => (index >= 60 ? `new ${index}` : `frame ${index}`));
    const { runs, hashes } = await findIdenticalFrameRuns({
      framesDir: framesDirWith(current.map((content, index) => (index < 40 ? null : content))),
      frameExt: "jpg",
      frameCount: 90,
      cachedHashes: hashesOf(cached),
      skippedRuns: [{ startFrame: 0, endFrame: 40 }],
    });
    expect(runs).toEqual([{ startFrame: 0, endFrame: 60 }]);
    expect(hashes.equals(hashesOf(current))).toBe(true);
  });

  it("refuses a skipped frame the cache has no hash for", async () => {
    await expect(
      findIdenticalFrameRuns({
        framesDir: framesDirWith([]),
        frameExt: "jpg",
        frameCount: 40,
        cachedHashes: Buffer.alloc(30 * FRAME_HASH_BYTES),
        skippedRuns: [{ startFrame: 0, endFrame: 40 }],
      }),
    ).rejects.toThrow("no cached hash for skipped frames 0-40");
  });
});
