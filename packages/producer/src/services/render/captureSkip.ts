/**
 * Decides, before capture, which frames need not be captured because the
 * cached render holds them. A run is skipped when the clip fingerprints
 * predict it unchanged and every probe frame inside it matches the cached
 * render's probe.
 *
 * Probes are compared with probes, never with the workers' frame hashes: a
 * frame reached by a jump and the same frame reached by stepping through the
 * timeline are not always the same bytes, while two jumps to it are.
 */

import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import { join } from "node:path";
import {
  captureFrameToBuffer,
  closeCaptureSession,
  createCaptureSession,
  initializeSession,
  type CaptureOptions,
  type CaptureSession,
  type EngineConfig,
} from "@hyperframes/engine";
import type { Fps } from "@hyperframes/core";
import type { ProducerLogger } from "../../logger.js";
import {
  collectClipFingerprints,
  predictUnchangedRuns,
  type ClipFingerprints,
  type FrameProbe,
  type PageFingerprints,
} from "./clipFingerprint.js";
import {
  frameCacheMinReuseFrames,
  planFrameCacheSegments,
  readCachedRender,
  type CachedRender,
} from "./frameCache.js";
import type { FrameRun } from "./frameDiff.js";

export interface CaptureSkipPlan {
  /** This render's fingerprints, kept in the cache; `null` when it has none. */
  clips: ClipFingerprints | null;
  /** Frames left uncaptured, ascending and disjoint. */
  skippedRuns: FrameRun[];
  /** Frames to capture: the rest of `[0, totalFrames)`. */
  captureRuns: FrameRun[];
  /** Why nothing is skipped, when nothing is. */
  reason?: string;
  /** Probe frames captured on the planning session. */
  probedFrames: number;
}

/** What it takes to open a planning session when the render has no probe session. */
export interface PlanningSessionOptions {
  serverUrl: string;
  outputDir: string;
  captureOptions: CaptureOptions;
  cfg: EngineConfig;
}

async function openPlanningSession(options: PlanningSessionOptions): Promise<CaptureSession> {
  const session = await createCaptureSession(
    options.serverUrl,
    options.outputDir,
    options.captureOptions,
    null,
    options.cfg,
  );
  try {
    await initializeSession(session);
    return session;
  } catch (error) {
    await closeCaptureSession(session).catch(() => {});
    throw error;
  }
}

/** `HF_FRAME_CACHE_SKIP_CAPTURE=false` keeps the cache but captures every frame. */
export function isCaptureSkipEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env.HF_FRAME_CACHE_SKIP_CAPTURE?.trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

/**
 * The runs worth skipping: sections the fingerprints predict unchanged, cut to
 * what the frame cache would reuse (whole GOPs of the cached render, long
 * enough to be worth a cut).
 */
export function planSkippedRuns(input: {
  cached: Pick<CachedRender, "totalFrames" | "settings" | "clips">;
  current: PageFingerprints;
  totalFrames: number;
  fps: Fps;
}): FrameRun[] {
  const { cached, current, totalFrames, fps } = input;
  if (!cached.clips || cached.settings.fps !== `${fps.num}/${fps.den}`) return [];
  return planFrameCacheSegments({
    totalFrames,
    cachedFrames: cached.totalFrames,
    identicalRuns: predictUnchangedRuns({ cached: cached.clips, current, totalFrames, fps }),
    gopSize: cached.settings.gopSize,
    fps,
    minReuseFrames: frameCacheMinReuseFrames(fps),
  })
    .filter((segment) => segment.status === "reuse")
    .map(({ startFrame, endFrame }) => ({ startFrame, endFrame }));
}

/** The frames of `[0, totalFrames)` outside `skippedRuns`, as runs. */
export function captureRunsFor(skippedRuns: readonly FrameRun[], totalFrames: number): FrameRun[] {
  const runs: FrameRun[] = [];
  let next = 0;
  for (const run of skippedRuns) {
    if (run.startFrame > next) runs.push({ startFrame: next, endFrame: run.startFrame });
    next = run.endFrame;
  }
  if (next < totalFrames) runs.push({ startFrame: next, endFrame: totalFrames });
  return runs;
}

/**
 * Move a run captured on its own (files numbered from 0 in `runDir`) to its
 * place in the render's frame directory, where files carry the frame index.
 */
export function moveCapturedRun(
  runDir: string,
  framesDir: string,
  run: FrameRun,
  frameExt: "jpg" | "png",
): void {
  const name = (index: number): string => `frame_${String(index).padStart(6, "0")}.${frameExt}`;
  for (let frame = run.startFrame; frame < run.endFrame; frame++) {
    renameSync(join(runDir, name(frame - run.startFrame)), join(framesDir, name(frame)));
  }
}

/** Most probes one render captures; each costs about one frame's capture. */
const MAX_PROBE_FRAMES = 32;

/**
 * The frames probed on every render: evenly spaced, one per shortest reusable
 * section (so every run worth skipping holds one) until that would exceed
 * `MAX_PROBE_FRAMES`, and further apart beyond that.
 */
export function probeFramesFor(totalFrames: number, fps: Fps): number[] {
  if (totalFrames <= 0) return [];
  const spacing = Math.max(
    frameCacheMinReuseFrames(fps),
    Math.ceil(totalFrames / MAX_PROBE_FRAMES),
  );
  const frames: number[] = [];
  for (let frame = Math.floor(spacing / 2); frame < totalFrames; frame += spacing) {
    frames.push(frame);
  }
  return frames.length > 0 ? frames : [0];
}

/**
 * The planned runs whose probes all match the cached render's. A run with no
 * probe inside it, or a probe the cached render did not take, is not verified.
 */
export function verifySkippedRuns(input: {
  planned: readonly FrameRun[];
  cached: readonly FrameProbe[];
  current: readonly FrameProbe[];
}): { verified: FrameRun[]; mismatches: { run: FrameRun; frame: number | null }[] } {
  const cachedHashes = new Map(input.cached.map((probe) => [probe.frame, probe.hash]));
  const verified: FrameRun[] = [];
  const mismatches: { run: FrameRun; frame: number | null }[] = [];
  for (const run of input.planned) {
    const inside = input.current.filter(
      (probe) => probe.frame >= run.startFrame && probe.frame < run.endFrame,
    );
    const differing = inside.find((probe) => cachedHashes.get(probe.frame) !== probe.hash);
    if (inside.length > 0 && !differing) verified.push(run);
    else mismatches.push({ run, frame: differing?.frame ?? null });
  }
  return { verified, mismatches };
}

async function captureFrameHash(session: CaptureSession, frame: number, fps: Fps): Promise<Buffer> {
  // Static-frame dedup would hand back the previous capture's buffer.
  session.lastFrameBuffer = undefined;
  session.lastFrameAbsoluteIndex = undefined;
  const { buffer } = await captureFrameToBuffer(session, frame, (frame * fps.den) / fps.num);
  return createHash("sha256").update(buffer).digest();
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`[captureSkip] ${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Fingerprint the composition and plan which frames to capture. A failure
 * plans a full capture and says why; only an abort throws. `session` in the
 * result is the planning session, still open, for the capture stage to take
 * over as its probe session; `null` when none could be opened.
 */
export async function planCaptureSkip(input: {
  /** The render's probe session, when it has one. */
  session: CaptureSession | null;
  openSession: PlanningSessionOptions;
  cacheDir: string;
  totalFrames: number;
  fps: Fps;
  log: ProducerLogger;
  signal?: AbortSignal;
}): Promise<{ plan: CaptureSkipPlan; session: CaptureSession | null }> {
  let session = input.session;
  if (!session) {
    try {
      session = await openPlanningSession(input.openSession);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return {
        plan: fullCapture(input.totalFrames, `no planning session: ${message}`),
        session: null,
      };
    }
  }
  return { plan: await planOnSession(session, input), session };
}

function fullCapture(
  totalFrames: number,
  reason: string,
  clips: ClipFingerprints | null = null,
): CaptureSkipPlan {
  return {
    clips,
    skippedRuns: [],
    captureRuns: [{ startFrame: 0, endFrame: totalFrames }],
    reason,
    probedFrames: clips?.probes.length ?? 0,
  };
}

/**
 * The plan for a render with fingerprints `clips`, given what the cache holds:
 * skip the runs the fingerprints predict unchanged and the probes confirm.
 */
export function planFromFingerprints(input: {
  cached: Pick<CachedRender, "totalFrames" | "settings" | "clips"> | null;
  clips: ClipFingerprints;
  totalFrames: number;
  fps: Fps;
  log: Pick<ProducerLogger, "info">;
}): CaptureSkipPlan {
  const { cached, clips, totalFrames, fps } = input;
  if (!cached) return fullCapture(totalFrames, "no cached render", clips);
  if (!cached.clips) return fullCapture(totalFrames, "cached render has no fingerprints", clips);
  const planned = planSkippedRuns({ cached, current: clips, totalFrames, fps });
  if (planned.length === 0) return fullCapture(totalFrames, "no unchanged section", clips);

  const { verified, mismatches } = verifySkippedRuns({
    planned,
    cached: cached.clips.probes,
    current: clips.probes,
  });
  for (const { run, frame } of mismatches) {
    input.log.info("[Render] Frame cache: probe frames do not confirm a run; capturing it.", {
      run: `${run.startFrame}-${run.endFrame}`,
      frame: frame ?? "none in the run",
    });
  }
  if (verified.length === 0) return fullCapture(totalFrames, "probe frames differ", clips);
  return {
    clips,
    skippedRuns: verified,
    captureRuns: captureRunsFor(verified, totalFrames),
    probedFrames: clips.probes.length,
  };
}

async function captureProbes(
  session: CaptureSession,
  totalFrames: number,
  fps: Fps,
  signal: AbortSignal | undefined,
): Promise<FrameProbe[]> {
  const probes: FrameProbe[] = [];
  for (const frame of probeFramesFor(totalFrames, fps)) {
    signal?.throwIfAborted();
    probes.push({ frame, hash: (await captureFrameHash(session, frame, fps)).toString("hex") });
  }
  return probes;
}

async function planOnSession(
  session: CaptureSession,
  input: {
    cacheDir: string;
    totalFrames: number;
    fps: Fps;
    log: ProducerLogger;
    signal?: AbortSignal;
  },
): Promise<CaptureSkipPlan> {
  const { totalFrames, fps } = input;
  // Probe frames are captured out of order on this session. Only the
  // screenshot path is known to tolerate that.
  if (session.captureMode !== "screenshot") {
    return fullCapture(totalFrames, `${session.captureMode} capture`);
  }
  let clips: ClipFingerprints | null = null;
  try {
    // Computed styles depend on the seek position, so pin it.
    await captureFrameHash(session, 0, fps);
    const collected = await collectClipFingerprints(session.page, fetchBytes);
    if (!collected.eligible) return fullCapture(totalFrames, collected.reason);
    const probes = await captureProbes(session, totalFrames, fps, input.signal);
    clips = { ...collected.fingerprints, probes };
    return planFromFingerprints({
      cached: readCachedRender(input.cacheDir),
      clips,
      totalFrames,
      fps,
      log: input.log,
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return fullCapture(totalFrames, `planning failed: ${message}`, clips);
  } finally {
    session.lastFrameBuffer = undefined;
    session.lastFrameAbsoluteIndex = undefined;
  }
}
