import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFPROBE_PATH_ENV, getFfmpegBinary, getFfprobeBinary } from "../utils/ffmpegBinaries.js";
import { processCompositionAudio } from "./audioMixer.js";
import { extractAudioMetadata, extractMediaMetadata } from "../utils/ffprobe.js";
import {
  extractVideoFramesRange,
  getFrameAtTime,
  resolveFinalFrameExtractionWindow,
  resolvePlayableVideoDuration,
  resolveVideoExtractionWindow,
} from "./videoFrameExtractor.js";

const FFMPEG = getFfmpegBinary();
const HAS_FFMPEG = spawnSync(FFMPEG, ["-version"]).status === 0;
const SAMPLE_RATE = 48_000;
const LEAD_SECONDS = 7;
const CLIP_SECONDS = 12;
const PICTURE_SECONDS = 20;

function ffmpeg(args: string[]): void {
  const result = spawnSync(FFMPEG, ["-nostdin", "-v", "error", "-y", ...args], {
    encoding: "utf-8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
}

/** Per output second, the source second heard (the tone is 200 + 100 * source second Hz), or null for silence. */
function sourceSecondsHeard(path: string, seconds: number): Array<number | null> {
  const decoded = spawnSync(
    FFMPEG,
    ["-v", "error", "-i", path, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"],
    { maxBuffer: 1 << 28 },
  );
  if (decoded.status !== 0) throw new Error(decoded.stderr.toString());
  const pcm = decoded.stdout;
  const heard: Array<number | null> = [];
  const edge = 2_000;
  for (let second = 0; second < seconds; second += 1) {
    let crossings = 0;
    let energy = 0;
    let previous = 0;
    for (let i = second * SAMPLE_RATE + edge; i < (second + 1) * SAMPLE_RATE - edge; i += 1) {
      const sample = pcm.readInt16LE(i * 2);
      energy += sample * sample;
      if (i > second * SAMPLE_RATE + edge && previous < 0 !== sample < 0) crossings += 1;
      previous = sample;
    }
    const windowSeconds = (SAMPLE_RATE - 2 * edge) / SAMPLE_RATE;
    const rms = Math.sqrt(energy / (SAMPLE_RATE - 2 * edge));
    heard.push(rms < 30 ? null : Math.round((crossings / 2 / windowSeconds - 200) / 100) + 0);
  }
  return heard;
}

describe.skipIf(!HAS_FFMPEG)(
  "sources whose audio and video streams start at different times",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-stream-start-"));

    beforeAll(() => {
      ffmpeg([
        "-f",
        "lavfi",
        "-i",
        `testsrc=size=64x36:rate=30:duration=${PICTURE_SECONDS}`,
        "-c:v",
        "libx264",
        "-g",
        "300",
        "-pix_fmt",
        "yuv420p",
        join(dir, "picture.mp4"),
      ]);
      ffmpeg([
        "-f",
        "lavfi",
        "-i",
        `aevalsrc='0.1*sin(2*PI*(200+100*floor(t))*t)':s=${SAMPLE_RATE}:d=20`,
        "-c:a",
        "aac",
        join(dir, "steps.m4a"),
      ]);
      const lead = String(LEAD_SECONDS);
      const picture = join(dir, "picture.mp4");
      const steps = join(dir, "steps.m4a");
      const maps = ["-map", "0:v", "-map", "1:a"];
      const mux = [...maps, "-c", "copy"];
      ffmpeg(["-itsoffset", lead, "-i", picture, "-i", steps, ...mux, join(dir, "video-late.mp4")]);
      ffmpeg(["-i", picture, "-itsoffset", lead, "-i", steps, ...mux, join(dir, "audio-late.mp4")]);
      ffmpeg(["-i", picture, "-i", steps, ...mux, join(dir, "aligned.mp4")]);
      const steps45 = join(dir, "steps45.m4a");
      ffmpeg([
        "-f",
        "lavfi",
        "-i",
        `aevalsrc='0.1*sin(2*PI*(200+100*floor(t))*t)':s=${SAMPLE_RATE}:d=45`,
        steps45,
      ]);
      ffmpeg([
        "-itsoffset",
        "20",
        "-i",
        picture,
        "-i",
        steps45,
        ...mux,
        join(dir, "video-late-20.mp4"),
      ]);
      const remux = (from: string, to: string) =>
        ffmpeg(["-i", join(dir, from), "-c", "copy", join(dir, to)]);
      // MPEG-TS starts its clock at 1.4 s, so no stream starts at 0.
      remux("video-late.mp4", "video-late.ts");
      // A lead past ffprobe's probe window makes it give the late stream the container's timing.
      remux("video-late.mp4", "video-late.mkv");
      remux("audio-late.mp4", "audio-late.mkv");
      remux("video-late-20.mp4", "video-late-20.ts");
      remux("video-late-20.mp4", "video-late-20.nut");
      // FLV gives a late video a start but no duration.
      remux("video-late.mp4", "video-late.flv");
      const webm = (videoOffset: string, audioOffset: string, to: string) =>
        ffmpeg([
          ...["-itsoffset", videoOffset, "-i", picture, "-itsoffset", audioOffset, "-i", steps],
          ...[...maps, "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8"],
          ...["-c:a", "libopus", join(dir, to)],
        ]);
      webm(lead, "0", "video-late.webm");
      webm("0", lead, "audio-late.webm");
      webm("0", "0", "aligned.webm");
    }, 60_000);

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const flatLane = {
      target: "rate",
      points: [
        { t: 0, v: 1 },
        { t: CLIP_SECONDS, v: 1 },
      ],
    };
    it.each([
      { source: "video-late.mp4", audioLead: 0, type: "video", mediaStart: 0 },
      { source: "video-late.mp4", audioLead: 0, type: "video", mediaStart: 3 },
      { source: "video-late.mp4", audioLead: 0, type: "audio", mediaStart: 0 },
      { source: "video-late.ts", audioLead: 0, type: "video", mediaStart: 0 },
      { source: "video-late.webm", audioLead: 0, type: "video", mediaStart: 0 },
      { source: "video-late.mkv", audioLead: 0, type: "video", mediaStart: 0 },
      { source: "video-late-20.ts", audioLead: 0, type: "video", mediaStart: 0 },
      { source: "video-late-20.nut", audioLead: 0, type: "video", mediaStart: 0 },
      { source: "aligned.webm", audioLead: 0, type: "video", mediaStart: 0 },
      { source: "audio-late.webm", audioLead: LEAD_SECONDS, type: "video", mediaStart: 0 },
      { source: "audio-late.mkv", audioLead: LEAD_SECONDS, type: "video", mediaStart: 0 },
      { source: "video-late.mp4", audioLead: 0, type: "video", mediaStart: 3, rate: flatLane },
      { source: "audio-late.mp4", audioLead: LEAD_SECONDS, type: "video", mediaStart: 0 },
      { source: "audio-late.mp4", audioLead: LEAD_SECONDS, type: "video", mediaStart: 3 },
      { source: "audio-late.mp4", audioLead: LEAD_SECONDS, type: "audio", mediaStart: 0 },
      {
        source: "audio-late.mp4",
        audioLead: LEAD_SECONDS,
        type: "video",
        mediaStart: 0,
        seconds: 5,
      },
    ] as const)(
      "%#: $source as <$type> from $mediaStart s plays each second where the browser plays it",
      async ({ source, audioLead, type, mediaStart, ...rest }) => {
        const seconds = "seconds" in rest ? rest.seconds : CLIP_SECONDS;
        const workDir = mkdtempSync(join(dir, "work-"));
        const outputPath = `${workDir}.m4a`;
        const result = await processCompositionAudio(
          [
            {
              id: "clip",
              src: source,
              start: 0,
              end: seconds,
              mediaStart,
              ...("rate" in rest ? { playbackRate: rest.rate } : {}),
              layer: 0,
              volume: 1,
              type,
            },
          ],
          dir,
          workDir,
          outputPath,
          seconds,
        );
        expect(result.success, JSON.stringify(result)).toBe(true);
        const expected = Array.from({ length: seconds }, (_, second) => {
          const mediaTime = mediaStart + second;
          return mediaTime < audioLead ? null : mediaTime - audioLead;
        });
        expect(sourceSecondsHeard(outputPath, seconds)).toEqual(expected);
      },
      30_000,
    );

    // Chrome, seeking a late video stream, paints nothing until its first frame is under 1 s away.
    it("shows no video frame while a late video stream's first frame is a second or more away", async () => {
      const extracted = await extractVideoFramesRange(
        join(dir, "video-late.mp4"),
        "video-late",
        0,
        CLIP_SECONDS,
        { fps: 30, outputDir: join(dir, "frames") },
      );
      expect(getFrameAtTime(extracted, 1, 0)).toBeNull();
      expect(getFrameAtTime(extracted, LEAD_SECONDS - 1.1, 0)).toBeNull();
      expect(getFrameAtTime(extracted, LEAD_SECONDS - 0.9, 0)).not.toBeNull();
      expect(getFrameAtTime(extracted, 8, 0)).not.toBeNull();
    }, 30_000);

    it("keeps every frame of a video stream that starts first", async () => {
      const extracted = await extractVideoFramesRange(
        join(dir, "audio-late.mp4"),
        "audio-late",
        0,
        CLIP_SECONDS,
        { fps: 30, outputDir: join(dir, "frames") },
      );
      expect(getFrameAtTime(extracted, 0, 0)).not.toBeNull();
      expect(getFrameAtTime(extracted, 1, 0)).not.toBeNull();
    }, 30_000);

    it("hides a late video stream's lead in a transport whose clock starts at 1.4 s", async () => {
      const extracted = await extractVideoFramesRange(
        join(dir, "video-late.ts"),
        "video-late-ts",
        0,
        CLIP_SECONDS,
        { fps: 30, outputDir: join(dir, "frames") },
      );
      expect(getFrameAtTime(extracted, 1, 0)).toBeNull();
      expect(getFrameAtTime(extracted, LEAD_SECONDS - 0.5, 0)).not.toBeNull();
    }, 30_000);

    it("plays a late video stream to its end on the media timeline and loops on its full length", async () => {
      const source = join(dir, "video-late.mp4");
      const mediaSeconds = LEAD_SECONDS + PICTURE_SECONDS;
      const window = resolveVideoExtractionWindow(
        { start: 0, end: mediaSeconds, mediaStart: 0, loop: false },
        await extractMediaMetadata(source),
        mediaSeconds,
      );
      expect(window.durationSeconds).toBeCloseTo(mediaSeconds, 1);

      const extracted = await extractVideoFramesRange(source, "video-late-full", 0, mediaSeconds, {
        fps: 10,
        outputDir: join(dir, "frames"),
      });
      expect(getFrameAtTime(extracted, PICTURE_SECONDS + 1.5, 0, true)).not.toBeNull();
      expect(getFrameAtTime(extracted, mediaSeconds + 1.5, 0, true)).toBeNull();
    }, 30_000);

    it.each([6.5, 10])(
      "shows a late video stream from a trim at %s s on the media timeline",
      async (mediaStart) => {
        const extracted = await extractVideoFramesRange(
          join(dir, "video-late.mp4"),
          `video-late-from-${mediaStart}`,
          mediaStart,
          5,
          { fps: 10, outputDir: join(dir, "frames") },
        );
        expect(getFrameAtTime(extracted, 0.05, 0, false, mediaStart)).not.toBeNull();
      },
      30_000,
    );

    it("holds a late video stream's last frame past its end", async () => {
      const source = join(dir, "video-late.mp4");
      const metadata = await extractMediaMetadata(source);
      const video = {
        start: 0,
        end: 5,
        mediaStart: LEAD_SECONDS + PICTURE_SECONDS + 0.5,
        loop: false,
      };
      const window = await resolveFinalFrameExtractionWindow(
        source,
        video,
        metadata,
        resolveVideoExtractionWindow(video, metadata, 5),
      );
      expect(window.extractionMediaStart).toBeGreaterThan(LEAD_SECONDS + PICTURE_SECONDS - 0.1);
    }, 30_000);

    it.each(["video-late.webm", "video-late.mkv", "video-late.flv"])(
      "%s: hides the late video's lead and ends it where the stream ends",
      async (name) => {
        const source = join(dir, name);
        expect(resolvePlayableVideoDuration(await extractMediaMetadata(source))).toBeCloseTo(
          LEAD_SECONDS + PICTURE_SECONDS,
          0,
        );
        const extracted = await extractVideoFramesRange(source, name, 0, CLIP_SECONDS, {
          fps: 10,
          outputDir: join(dir, "frames"),
        });
        expect(getFrameAtTime(extracted, 1, 0)).toBeNull();
        expect(getFrameAtTime(extracted, LEAD_SECONDS - 0.5, 0)).not.toBeNull();
      },
      60_000,
    );

    it.each(["video-late-20.ts", "video-late-20.nut"])(
      "%s: finds a 20 s video lead that ffprobe reports as the container's start",
      async (name) => {
        const metadata = await extractMediaMetadata(join(dir, name));
        expect(metadata.videoStreamLeadSeconds).toBeCloseTo(20, 1);
        expect(resolvePlayableVideoDuration(metadata)).toBeCloseTo(20 + PICTURE_SECONDS, 0);
      },
    );

    it("hides a 20 s video lead in NUT and shows the video after it", async () => {
      const source = join(dir, "video-late-20.nut");
      const extracted = await extractVideoFramesRange(source, "video-late-20-nut", 0, 22, {
        fps: 10,
        outputDir: join(dir, "frames"),
      });
      expect(getFrameAtTime(extracted, 1, 0)).toBeNull();
      expect(getFrameAtTime(extracted, 19.5, 0)).not.toBeNull();
    }, 60_000);

    it("keeps an aligned MP4's timing exactly as ffprobe reports it", async () => {
      const source = join(dir, "aligned.mp4");
      const video = await extractMediaMetadata(source);
      expect(video.videoStreamLeadSeconds).toBe(0);
      expect(video.videoStreamDurationSeconds).toBe(PICTURE_SECONDS);
      expect((await extractAudioMetadata(source)).latestStreamLeadSeconds).toBe(0);
    });

    it.skipIf(process.platform === "win32")(
      "does not cache the timing of a probe whose packet read failed",
      async () => {
        const marker = join(dir, "failed-once");
        const fake = join(dir, "ffprobe-fails-once");
        const real = getFfprobeBinary();
        writeFileSync(
          fake,
          `#!/bin/sh\ncase "$*" in *"%+#1"*) [ -e "${marker}" ] || { : > "${marker}"; exit 1; } ;; esac\nexec "${real}" "$@"\n`,
          { mode: 0o755 },
        );
        const source = join(dir, "video-late-uncached.webm");
        copyFileSync(join(dir, "video-late.webm"), source);
        const previous = process.env[FFPROBE_PATH_ENV];
        process.env[FFPROBE_PATH_ENV] = fake;
        try {
          expect((await extractMediaMetadata(source)).videoStreamLeadSeconds).toBe(0);
          expect((await extractMediaMetadata(source)).videoStreamLeadSeconds).toBeCloseTo(
            LEAD_SECONDS,
            1,
          );
        } finally {
          if (previous === undefined) delete process.env[FFPROBE_PATH_ENV];
          else process.env[FFPROBE_PATH_ENV] = previous;
        }
      },
    );
  },
);
