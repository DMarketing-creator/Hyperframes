/**
 * Frame cache for the disk-capture path: frames unchanged since the previous
 * render are stream-copied out of its video, the rest are encoded, and the
 * pieces are concat-copied in frame order. `skippedRuns` are frames that were
 * not captured (see `captureSkip.ts`) and are always reused.
 *
 * Reuse is decided per frame and applied per GOP: a stream copy can only cut
 * on a keyframe, so a cached video has one every `gopSize` frames.
 *
 * The manifest is written last, so an interrupted update leaves none and the
 * next render starts from scratch.
 */

import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import {
  buildConcatArgs,
  buildEncoderArgs,
  runFfmpeg,
  type EncoderOptions,
} from "@hyperframes/engine";
import { fpsToFfmpegArg, type Fps } from "@hyperframes/core";
import type { ProducerLogger } from "../../logger.js";
import type { ClipFingerprints } from "./clipFingerprint.js";
import { FRAME_HASH_BYTES, findIdenticalFrameRuns, type FrameRun } from "./frameDiff.js";

export type { FrameRun };

const FRAME_CACHE_DIRNAME = ".hf-frame-cache";
const MANIFEST_FILENAME = "manifest.json";
const HASHES_FILENAME = "hashes.bin";
/** Bumped when the layout changes; a cache of another version is discarded. */
const CACHE_VERSION = 4;

export interface FrameCacheSegment extends FrameRun {
  /** `reuse` comes out of the cached video as is; `render` is encoded from frames. */
  status: "reuse" | "render";
  /** Timeline position of `startFrame` and `endFrame`, in seconds. */
  startSeconds: number;
  endSeconds: number;
}

/** An identical run shorter than this is not worth splitting the video for. */
const MIN_REUSE_SECONDS = 2;

/** Everything that must match for a cached video to be reusable. Key order is fixed by `frameCacheSettings`. */
export interface FrameCacheSettings {
  fps: string;
  width: number;
  height: number;
  format: string;
  codec: string;
  preset: string;
  quality: number;
  bitrate: string | null;
  pixelFormat: string;
  hdrTransfer: string | null;
  vp9CpuUsed: number | null;
  imageFormat: "jpg" | "png";
  gopSize: number;
}

interface FrameCacheManifest {
  version: typeof CACHE_VERSION;
  settings: FrameCacheSettings;
  totalFrames: number;
  videoFile: string;
  /** `null` when the composition could not be fingerprinted. */
  clips: ClipFingerprints | null;
}

/** The cached render, as far as planning needs it. */
export interface CachedRender {
  totalFrames: number;
  settings: Pick<FrameCacheSettings, "fps" | "gopSize">;
  /** One SHA-256 per frame, laid end to end. */
  hashes: Buffer;
  clips: ClipFingerprints | null;
}

/**
 * Frames were left uncaptured on the cache's word and the cache could not
 * deliver them. The caller must capture the skipped frames and encode again.
 */
export class FrameCacheSkipError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FrameCacheSkipError";
  }

  /** `error` itself when it already is one, otherwise a new one caused by it. */
  static from(error: unknown): FrameCacheSkipError {
    return error instanceof FrameCacheSkipError
      ? error
      : new FrameCacheSkipError("[frameCache] encode failed with frames skipped", {
          cause: error,
        });
  }
}

/** Why the cached render was or was not used. */
export type FrameCacheStatus = "hit" | "no-cache" | "settings-changed";

export interface FrameCacheEncodeResult {
  status: FrameCacheStatus;
  framesEncoded: number;
  framesReused: number;
  /** Reused frames that were never captured this render. */
  framesNotCaptured: number;
  segments: FrameCacheSegment[];
}

export function frameCacheDirFor(projectRendersDir: string): string {
  return join(projectRendersDir, FRAME_CACHE_DIRNAME);
}

/** `HF_FRAME_CACHE=false` is the kill switch; anything else leaves the cache on. */
export function isFrameCacheEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env.HF_FRAME_CACHE?.trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

/**
 * Frames per GOP for a cached render. ProRes is intra-only, so every frame is
 * a cut point; the inter-frame codecs get one keyframe a second.
 */
export function frameCacheGopSize(codec: string, fps: Fps): number {
  if (codec === "prores") return 1;
  return Math.max(1, Math.round(fps.num / fps.den));
}

export function frameCacheSettings(input: {
  fps: Fps;
  format: string;
  imageFormat: "jpg" | "png";
  gopSize: number;
  encoder: EncoderOptions;
}): FrameCacheSettings {
  const { encoder } = input;
  return {
    fps: `${input.fps.num}/${input.fps.den}`,
    width: encoder.width,
    height: encoder.height,
    format: input.format,
    codec: encoder.codec ?? "h264",
    preset: encoder.preset ?? "",
    quality: encoder.quality ?? -1,
    bitrate: encoder.bitrate ?? null,
    pixelFormat: encoder.pixelFormat ?? "",
    hdrTransfer: encoder.hdr?.transfer ?? null,
    vp9CpuUsed: encoder.vp9CpuUsed ?? null,
    imageFormat: input.imageFormat,
    gopSize: input.gopSize,
  };
}

/**
 * Render segments encoded at once: the explicit `--workers N` when given,
 * otherwise two. One software encode already spreads over several cores, so
 * the default stays low.
 */
export function frameCacheEncodeConcurrency(requestedWorkers: number | undefined): number {
  return requestedWorkers === undefined ? 2 : Math.max(1, Math.floor(requestedWorkers));
}

export function frameCacheMinReuseFrames(fps: Fps): number {
  return Math.max(1, Math.round((MIN_REUSE_SECONDS * fps.num) / fps.den));
}

/**
 * Build the segment map: `reuse` and `render` segments covering
 * `[0, totalFrames)` with no gaps or overlaps. A GOP is reused only when it
 * lies inside one identical run and spans the same frames in both renders, so
 * a GOP that gained or lost frames at the tail is rendered. A reuse segment
 * shorter than `minReuseFrames` joins the render segment beside it.
 */
export function planFrameCacheSegments(input: {
  totalFrames: number;
  cachedFrames: number;
  /** Runs of frames identical to the cached render, ascending and disjoint. */
  identicalRuns: readonly FrameRun[];
  gopSize: number;
  fps: Fps;
  minReuseFrames?: number;
}): FrameCacheSegment[] {
  const { fps, minReuseFrames = 0 } = input;
  const perGop = planGopRuns(input);
  // Statuses alternate here, so any reuse segment in a map of two or more has
  // a render neighbour to join.
  const segments: FrameCacheSegment[] = [];
  for (const { status: planned, startFrame, endFrame } of perGop) {
    const tooShort = perGop.length > 1 && endFrame - startFrame < minReuseFrames;
    const status = planned === "reuse" && tooShort ? "render" : planned;
    const last = segments[segments.length - 1];
    if (last?.status === status) {
      last.endFrame = endFrame;
      last.endSeconds = (endFrame * fps.den) / fps.num;
      continue;
    }
    segments.push({
      status,
      startFrame,
      endFrame,
      startSeconds: (startFrame * fps.den) / fps.num,
      endSeconds: (endFrame * fps.den) / fps.num,
    });
  }
  return segments;
}

type StatusRun = FrameRun & { status: FrameCacheSegment["status"] };

/** One status per GOP of this render, neighbouring GOPs of a status merged. */
function planGopRuns(input: {
  totalFrames: number;
  cachedFrames: number;
  identicalRuns: readonly FrameRun[];
  gopSize: number;
}): StatusRun[] {
  const { totalFrames, cachedFrames, identicalRuns, gopSize } = input;
  // Past the last run nothing is identical; a sentinel keeps the loop simple.
  const runs = [...identicalRuns, { startFrame: Infinity, endFrame: Infinity }];
  const perGop: StatusRun[] = [];
  let run = runs[0];
  let runIndex = 0;
  for (let start = 0; start < totalFrames; start += gopSize) {
    const end = Math.min(start + gopSize, totalFrames);
    while (run !== undefined && run.endFrame < end) run = runs[++runIndex];
    const identical = run !== undefined && run.startFrame <= start;
    const sameSpan = end === Math.min(start + gopSize, cachedFrames);
    const status = identical && sameSpan ? "reuse" : "render";
    const last = perGop.at(-1);
    if (last?.status === status) last.endFrame = end;
    else perGop.push({ status, startFrame: start, endFrame: end });
  }
  return perGop;
}

function formatTimestamp(seconds: number): string {
  const totalMs = Math.round(seconds * 1000);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const clock = `${pad(Math.floor((totalSeconds % 3600) / 60))}:${pad(totalSeconds % 60)}`;
  return `${hours > 0 ? `${pad(hours)}:` : ""}${clock}${ms > 0 ? `.${pad(ms, 3)}` : ""}`;
}

/** One line of the segment map, e.g. `reuse 00:00-02:00 (frames 0-3600)`. */
export function formatFrameCacheSegment(segment: FrameCacheSegment): string {
  const span = `${formatTimestamp(segment.startSeconds)}-${formatTimestamp(segment.endSeconds)}`;
  return `${segment.status} ${span} (frames ${segment.startFrame}-${segment.endFrame})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isClipFingerprints(value: unknown): value is ClipFingerprints {
  if (!isRecord(value) || typeof value.global !== "string") return false;
  const { clips, probes } = value;
  return (
    Array.isArray(clips) &&
    clips.every(
      (clip) =>
        isRecord(clip) &&
        typeof clip.start === "number" &&
        typeof clip.end === "number" &&
        typeof clip.hash === "string",
    ) &&
    Array.isArray(probes) &&
    probes.every(
      (probe) =>
        isRecord(probe) && typeof probe.frame === "number" && typeof probe.hash === "string",
    )
  );
}

type CachedManifest = CachedRender & { videoFile: string; key: string };

/** The manifest's fields, without the hashes; `null` when it is not a current manifest. */
function parseManifest(parsed: unknown): Omit<CachedManifest, "hashes"> | null {
  if (!isRecord(parsed) || parsed.version !== CACHE_VERSION) return null;
  const { totalFrames, videoFile, settings } = parsed;
  if (typeof totalFrames !== "number" || typeof videoFile !== "string") return null;
  if (!isRecord(settings)) return null;
  if (typeof settings.fps !== "string" || typeof settings.gopSize !== "number") return null;
  return {
    totalFrames,
    videoFile,
    key: JSON.stringify(settings),
    settings: { fps: settings.fps, gopSize: settings.gopSize },
    clips: isClipFingerprints(parsed.clips) ? parsed.clips : null,
  };
}

function readManifest(cacheDir: string): CachedManifest | null {
  const manifestPath = join(cacheDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf-8")));
    if (!manifest || !existsSync(join(cacheDir, manifest.videoFile))) return null;
    const hashes = readFileSync(join(cacheDir, HASHES_FILENAME));
    if (hashes.length !== manifest.totalFrames * FRAME_HASH_BYTES) return null;
    return { ...manifest, hashes };
  } catch {
    return null;
  }
}

/** The cached render in `cacheDir`, or `null` when there is none usable. */
export function readCachedRender(cacheDir: string): CachedRender | null {
  return readManifest(cacheDir);
}

function copyFile(from: string, to: string): void {
  // Clone where the filesystem supports it (APFS, btrfs, xfs); plain copy otherwise.
  copyFileSync(from, to, constants.COPYFILE_FICLONE);
}

interface EncodeContext {
  framesDir: string;
  frameExt: "jpg" | "png";
  encoder: EncoderOptions;
  signal: AbortSignal | undefined;
  ffmpegTimeout: number;
}

async function ffmpegOrThrow(what: string, args: string[], ctx: EncodeContext): Promise<void> {
  const result = await runFfmpeg(args, { signal: ctx.signal, timeout: ctx.ffmpegTimeout });
  if (!result.success) {
    throw new Error(`[frameCache] ${what} failed: ${result.stderr.slice(-400)}`);
  }
}

async function encodeFrameRun(
  run: FrameRun,
  outputPath: string,
  ctx: EncodeContext,
): Promise<void> {
  const inputArgs = [
    "-framerate",
    fpsToFfmpegArg(ctx.encoder.fps),
    "-start_number",
    String(run.startFrame),
    "-i",
    join(ctx.framesDir, `frame_%06d.${ctx.frameExt}`),
    "-frames:v",
    String(run.endFrame - run.startFrame),
  ];
  await ffmpegOrThrow(
    `encode of frames ${run.startFrame}-${run.endFrame}`,
    buildEncoderArgs(ctx.encoder, inputArgs, outputPath),
    ctx,
  );
}

/**
 * Stream-copy the cached video into one file per reused run. Cuts are given as
 * frame numbers, not timestamps, so they cannot drift onto a neighbouring GOP.
 */
async function splitCachedVideo(
  cachedVideoPath: string,
  cachedFrames: number,
  segments: readonly FrameCacheSegment[],
  partsDir: string,
  ctx: EncodeContext,
): Promise<Map<number, string>> {
  const cuts = [...new Set(segments.flatMap((segment) => [segment.startFrame, segment.endFrame]))]
    .filter((frame) => frame > 0 && frame < cachedFrames)
    .sort((a, b) => a - b);
  const partByStartFrame = new Map<number, string>();
  if (cuts.length === 0) {
    partByStartFrame.set(0, cachedVideoPath);
    return partByStartFrame;
  }
  const ext = extname(cachedVideoPath);
  await ffmpegOrThrow(
    "split of the cached video",
    [
      "-i",
      cachedVideoPath,
      "-map",
      "0:v:0",
      "-c",
      "copy",
      "-f",
      "segment",
      "-segment_frames",
      cuts.join(","),
      "-reset_timestamps",
      "1",
      "-y",
      join(partsDir, `part_%05d${ext}`),
    ],
    ctx,
  );
  [0, ...cuts].forEach((startFrame, index) => {
    partByStartFrame.set(
      startFrame,
      join(partsDir, `part_${String(index).padStart(5, "0")}${ext}`),
    );
  });
  return partByStartFrame;
}

async function concatSegments(
  pieces: readonly { path: string; frames: number }[],
  outputPath: string,
  listPath: string,
  ctx: EncodeContext,
): Promise<void> {
  const { num, den } = ctx.encoder.fps;
  // An explicit duration per piece keeps the next piece's timestamps on the
  // frame grid; the container's own duration is rounded (to 1 ms in WebM).
  const body = pieces
    .map(
      (piece) =>
        `file '${piece.path.replace(/'/g, "'\\''")}'\nduration ${((piece.frames * den) / num).toFixed(6)}`,
    )
    .join("\n");
  writeFileSync(listPath, body, "utf-8");
  await ffmpegOrThrow("merge of the segments", buildConcatArgs(listPath, outputPath), ctx);
}

function writeManifest(cacheDir: string, manifest: FrameCacheManifest): void {
  writeFileSync(join(cacheDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), "utf-8");
}

function replaceCache(input: {
  cacheDir: string;
  /** This render's frame hashes, laid end to end. */
  hashes: Buffer;
  videoPath: string;
  settings: FrameCacheSettings;
  clips: ClipFingerprints | null;
}): void {
  const { cacheDir, hashes } = input;
  // Everything goes, so a cache in an older layout leaves nothing behind.
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, HASHES_FILENAME), hashes);
  const videoFile = `video${extname(input.videoPath)}`;
  copyFile(input.videoPath, join(cacheDir, videoFile));
  writeManifest(cacheDir, {
    version: CACHE_VERSION,
    settings: input.settings,
    totalFrames: hashes.length / FRAME_HASH_BYTES,
    videoFile,
    clips: input.clips,
  });
}

/**
 * Encode the render segments, up to `limit` at a time. The first failure
 * stops the encodes still running and is rethrown once they have all exited,
 * so none is left writing while the caller falls back.
 */
async function encodeRenderSegments(
  jobs: readonly { run: FrameRun; path: string }[],
  limit: number,
  ctx: EncodeContext,
  onSegmentDone: (frames: number) => void,
): Promise<void> {
  const stop = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, stop.signal]) : stop.signal;
  let next = 0;
  let failure: unknown;
  const lane = async (): Promise<void> => {
    while (failure === undefined && next < jobs.length) {
      const job = jobs[next++];
      if (!job) return;
      try {
        await encodeFrameRun(job.run, job.path, { ...ctx, signal });
        onSegmentDone(job.run.endFrame - job.run.startFrame);
      } catch (error) {
        failure ??= error;
        stop.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, lane));
  if (failure !== undefined) throw failure;
}

export interface FrameCacheEncodeInput {
  cacheDir: string;
  framesDir: string;
  frameExt: "jpg" | "png";
  /** Where the video is written. Scratch files go in a directory beside it. */
  videoOnlyPath: string;
  settings: FrameCacheSettings;
  /** Must lock the GOP to `settings.gopSize` for codecs that honor it. */
  encoder: EncoderOptions;
  /** Shortest identical run worth reusing. Defaults to `frameCacheMinReuseFrames`. */
  minReuseFrames?: number;
  /** Render segments encoded at once. Defaults to two. */
  maxParallelEncodes?: number;
  /** Frames of the render. Defaults to the number of frame files, which is wrong once any are skipped. */
  totalFrames?: number;
  /** Frames that were not captured because the cache was trusted for them; ascending and disjoint. */
  skippedRuns?: readonly FrameRun[];
  /** This render's clip fingerprints, kept for the next render. */
  clips?: ClipFingerprints | null;
  ffmpegTimeout: number;
  signal?: AbortSignal;
  log: ProducerLogger;
  /** Called with the running total of frames whose video is ready. */
  onFramesDone?: (frames: number) => void;
}

/** Throws `FrameCacheSkipError` unless every skipped run lies inside a reuse segment. */
function assertSkippedRunsReusable(
  skippedRuns: readonly FrameRun[],
  segments: readonly FrameCacheSegment[],
): void {
  const reuse = segments.filter((segment) => segment.status === "reuse");
  const outside = skippedRuns.find(
    (run) =>
      !reuse.some(
        (segment) => segment.startFrame <= run.startFrame && run.endFrame <= segment.endFrame,
      ),
  );
  if (outside) {
    throw new FrameCacheSkipError(
      `[frameCache] skipped frames ${outside.startFrame}-${outside.endFrame} are not reusable`,
    );
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Nothing changed: the cached video is the render, and the cache is current
 * apart from fingerprints it may not have had yet.
 */
function reuseCachedRender(
  input: FrameCacheEncodeInput,
  manifest: CachedManifest,
  clips: ClipFingerprints | null,
): void {
  const { cacheDir, settings } = input;
  copyFile(join(cacheDir, manifest.videoFile), input.videoOnlyPath);
  if (JSON.stringify(manifest.clips) === JSON.stringify(clips)) return;
  try {
    writeManifest(cacheDir, {
      version: CACHE_VERSION,
      settings,
      totalFrames: manifest.totalFrames,
      videoFile: manifest.videoFile,
      clips,
    });
  } catch (error) {
    input.log.warn("[Render] Frame cache: could not save the clip fingerprints.", {
      cacheDir,
      error: errorMessage(error),
    });
  }
}

/**
 * Build the video from a map of several segments: split the cached video,
 * encode the render segments, and merge everything in frame order.
 */
async function stitchSegments(
  input: FrameCacheEncodeInput,
  manifest: CachedManifest,
  segments: readonly FrameCacheSegment[],
  ctx: EncodeContext,
): Promise<void> {
  const { videoOnlyPath } = input;
  const scratchDir = mkdtempSync(join(dirname(videoOnlyPath), "frame-cache-"));
  const ext = extname(videoOnlyPath);
  const parts = await splitCachedVideo(
    join(input.cacheDir, manifest.videoFile),
    manifest.totalFrames,
    segments,
    scratchDir,
    ctx,
  );
  let framesDone = 0;
  const pieces = segments.map((segment, index) => {
    const frames = segment.endFrame - segment.startFrame;
    if (segment.status === "render") {
      const path = join(scratchDir, `encoded_${String(index).padStart(5, "0")}${ext}`);
      return { path, frames, render: segment };
    }
    const path = parts.get(segment.startFrame);
    if (path === undefined) {
      throw new Error(`[frameCache] no cached video for frames from ${segment.startFrame}`);
    }
    framesDone += frames;
    return { path, frames, render: null };
  });
  input.onFramesDone?.(framesDone);
  await encodeRenderSegments(
    pieces.flatMap((piece) => (piece.render ? [{ run: piece.render, path: piece.path }] : [])),
    input.maxParallelEncodes ?? frameCacheEncodeConcurrency(undefined),
    ctx,
    (frames) => {
      framesDone += frames;
      input.onFramesDone?.(framesDone);
    },
  );
  await concatSegments(pieces, videoOnlyPath, join(scratchDir, "concat-list.txt"), ctx);
}

/** The cached render when it was encoded with `settings`, and how the lookup went. */
function openCache(
  cacheDir: string,
  settings: FrameCacheSettings,
): { manifest: CachedManifest | null; status: FrameCacheStatus } {
  const cached = readManifest(cacheDir);
  if (!cached) return { manifest: null, status: "no-cache" };
  return cached.key === JSON.stringify(settings)
    ? { manifest: cached, status: "hit" }
    : { manifest: null, status: "settings-changed" };
}

function countFrameFiles(framesDir: string, frameExt: string): number {
  return readdirSync(framesDir).filter((name) => name.endsWith(`.${frameExt}`)).length;
}

/** Replace the cache with this render; a failure only costs the next render its head start. */
function saveRenderToCache(
  input: FrameCacheEncodeInput,
  hashes: Buffer,
  clips: ClipFingerprints | null,
): void {
  const { cacheDir } = input;
  try {
    replaceCache({
      cacheDir,
      hashes,
      videoPath: input.videoOnlyPath,
      settings: input.settings,
      clips,
    });
  } catch (error) {
    rmSync(cacheDir, { recursive: true, force: true });
    input.log.warn("[Render] Frame cache: could not save this render to the cache.", {
      cacheDir,
      error: errorMessage(error),
    });
  }
}

/**
 * Produce `videoOnlyPath` from the captured frames, reusing the cached video
 * for unchanged frames, then replace the cache with this render. Throws on any
 * failure; the caller falls back to an uncached encode. With `skippedRuns` it
 * throws `FrameCacheSkipError` when the cache cannot stand in for those frames,
 * before anything is written.
 */
export async function encodeWithFrameCache(
  input: FrameCacheEncodeInput,
): Promise<FrameCacheEncodeResult> {
  const { cacheDir, framesDir, frameExt, videoOnlyPath, settings } = input;
  const { fps } = input.encoder;
  const ctx: EncodeContext = {
    framesDir,
    frameExt,
    encoder: input.encoder,
    signal: input.signal,
    ffmpegTimeout: input.ffmpegTimeout,
  };
  const skippedRuns = input.skippedRuns ?? [];
  const clips = input.clips ?? null;
  const totalFrames = input.totalFrames ?? countFrameFiles(framesDir, frameExt);
  if (totalFrames === 0) throw new Error("[frameCache] no frame files found in directory");

  const { manifest, status } = openCache(cacheDir, settings);
  if (skippedRuns.length > 0 && !manifest) {
    throw new FrameCacheSkipError(`[frameCache] frames were skipped but the cache is ${status}`);
  }
  // Every frame is hashed either way: the hashes are what the cache keeps.
  const { runs: identicalRuns, hashes } = await findIdenticalFrameRuns({
    framesDir,
    frameExt,
    frameCount: totalFrames,
    cachedHashes: manifest ? manifest.hashes : Buffer.alloc(0),
    skippedRuns,
    signal: input.signal,
  });

  // Without a usable cache the whole timeline is one render segment.
  const segments = planFrameCacheSegments({
    totalFrames,
    cachedFrames: manifest ? manifest.totalFrames : 0,
    identicalRuns,
    gopSize: settings.gopSize,
    fps,
    minReuseFrames: input.minReuseFrames ?? frameCacheMinReuseFrames(fps),
  });
  // The skip was planned with this planner on fewer identical frames, so this
  // holds unless the cache changed between the two.
  assertSkippedRunsReusable(skippedRuns, segments);
  const framesReused = sumFrames(segments.filter((segment) => segment.status === "reuse"));
  const result: FrameCacheEncodeResult = {
    status,
    framesEncoded: totalFrames - framesReused,
    framesReused,
    framesNotCaptured: sumFrames(skippedRuns),
    segments,
  };

  if (framesReused === 0) {
    await encodeFrameRun({ startFrame: 0, endFrame: totalFrames }, videoOnlyPath, ctx);
    input.onFramesDone?.(totalFrames);
  } else if (!manifest) {
    throw new Error("[frameCache] reuse planned without a cached render");
  } else if (framesReused === totalFrames && manifest.totalFrames === totalFrames) {
    reuseCachedRender(input, manifest, clips);
    input.onFramesDone?.(totalFrames);
    return result;
  } else {
    await stitchSegments(input, manifest, segments, ctx);
  }
  saveRenderToCache(input, hashes, clips);
  return result;
}

function sumFrames(runs: readonly FrameRun[]): number {
  return runs.reduce((sum, run) => sum + run.endFrame - run.startFrame, 0);
}
