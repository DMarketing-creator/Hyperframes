/**
 * Fingerprints of the loaded page, taken before capture: one per top-level
 * `[data-start]` clip (its elements and the GSAP tweens targeting them) and
 * one for everything else, including the bytes of every loaded file.
 *
 * A frame is predicted unchanged when the global fingerprint and every clip
 * active at it match the cached render. A page holding anything the walk
 * cannot see into is not fingerprinted, and a prediction is checked against
 * probe frames before a capture is skipped (see `captureSkip.ts`).
 */

import { createHash } from "node:crypto";
import type { Page } from "puppeteer-core";
import type { Fps } from "@hyperframes/core";
import type { FrameRun } from "./frameDiff.js";

export interface ClipFingerprint {
  /** Seconds on the composition timeline, `[start, end)`. */
  start: number;
  end: number;
  hash: string;
}

/** The hash of one frame's image, captured on its own on the planning session. */
export interface FrameProbe {
  frame: number;
  hash: string;
}

export interface ClipFingerprints {
  /** Everything outside the clips, and every loaded resource. */
  global: string;
  clips: ClipFingerprint[];
  /** A few frames of the render, to check a prediction against pixels. */
  probes: FrameProbe[];
}

/** The part of the fingerprints read from the page. */
export type PageFingerprints = Pick<ClipFingerprints, "global" | "clips">;

export type ClipFingerprintResult =
  | { eligible: true; fingerprints: PageFingerprints; elements: number }
  | { eligible: false; reason: string };

/** Above this the computed-style walk costs more than it is likely to save. */
const MAX_FINGERPRINT_ELEMENTS = 5000;
/** Chrome's default resource-timing buffer; a full buffer may have dropped entries. */
const RESOURCE_TIMING_BUFFER = 250;

interface PageClips {
  reasons: string[];
  elements: number;
  global: string;
  clips: ClipFingerprint[];
  resources: string[];
}

/**
 * Serialized into the page, so it can only use what it declares itself: it
 * cannot be split into module-level helpers, and runs only in a browser.
 * `reasons` lists everything that makes the fingerprints untrustworthy.
 */
// fallow-ignore-next-line complexity
async function collectInPage(limits: {
  maxElements: number;
  resourceBuffer: number;
}): Promise<PageClips> {
  type Tween = {
    startTime(): number;
    totalDuration(): number;
    targets?(): unknown[];
    getChildren?(nested: boolean, tweens: boolean, timelines: boolean): Tween[];
    vars?: Record<string, unknown>;
  };
  const reasons = new Set<string>();
  const empty = { elements: 0, global: "", clips: [], resources: [] };
  const win = window as unknown as {
    __timelines?: Record<string, Tween>;
    __hfHasFrameSources?: () => boolean;
  };

  const elements = Array.from(document.body.querySelectorAll("*")).filter(
    (el) => el.tagName !== "SCRIPT" && el.tagName !== "STYLE",
  );
  if (elements.length > limits.maxElements) {
    return { ...empty, reasons: [`more than ${limits.maxElements} elements`] };
  }
  if (typeof crypto?.subtle?.digest !== "function") {
    return { ...empty, reasons: ["no SubtleCrypto in the page"] };
  }

  // Content that changes without a tween or a DOM difference.
  const opaque: Record<string, string> = {
    video: "video",
    canvas: "canvas/webgl",
    iframe: "iframe",
    "object, embed": "embedded object",
    "animate, animateTransform, animateMotion, set": "SVG animation",
    "lottie-player, dotlottie-player": "lottie player",
  };
  for (const [selector, reason] of Object.entries(opaque)) {
    if (document.querySelector(selector)) reasons.add(reason);
  }
  if (win.__hfHasFrameSources?.() === true) reasons.add("registered frame source");
  if (typeof document.getAnimations === "function" && document.getAnimations().length > 0) {
    reasons.add("CSS/WAAPI animation");
  }

  // Clips are the timed elements directly under the root composition; nested
  // timed elements belong to the clip that contains them.
  const root = document.querySelector("[data-composition-id]");
  const timed = Array.from(document.querySelectorAll<HTMLElement>("[data-start]")).filter(
    (el) => el !== root,
  );
  const clipElements = timed.filter((el) => {
    const outer = el.parentElement?.closest("[data-start]");
    return outer == null || outer === root;
  });
  const windows = clipElements.map((el) => {
    const start = Number(el.dataset.start);
    const end =
      el.dataset.end !== undefined ? Number(el.dataset.end) : start + Number(el.dataset.duration);
    return { start, end };
  });
  if (windows.some((w) => !Number.isFinite(w.start) || !Number.isFinite(w.end))) {
    reasons.add("clip without a numeric start and end");
  }

  // Index of the clip an element belongs to; -1 for the global part.
  const clipOf = (el: Element): number => clipElements.findIndex((clip) => clip.contains(el));
  const lines: string[][] = clipElements.map(() => []);
  const globalLines: string[] = [];
  const linesFor = (el: Element): string[] => lines[clipOf(el)] ?? globalLines;

  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const index = node.parentElement ? Array.from(node.parentElement.children).indexOf(node) : 0;
      parts.push(`${node.tagName}[${index}]`);
    }
    return parts.reverse().join(">");
  };
  const styleText = (el: Element, pseudo?: string): string => {
    const style = getComputedStyle(el, pseudo);
    let text = "";
    for (let i = 0; i < style.length; i++) {
      const prop = style.item(i);
      text += `${prop}:${style.getPropertyValue(prop)};`;
    }
    return text;
  };
  const pseudoText = (el: Element, pseudo: string): string => {
    const content = getComputedStyle(el, pseudo).content;
    return content === "none" || content === "normal" ? "" : styleText(el, pseudo);
  };
  for (const el of [document.documentElement, document.body, ...elements]) {
    if (el.shadowRoot) reasons.add("shadow DOM");
    const style = getComputedStyle(el);
    if (style.animationName !== "none") reasons.add("CSS/WAAPI animation");
    const attrs = Array.from(el.attributes)
      .map((attr) => `${attr.name}=${attr.value}`)
      .join(" ");
    const ownText = Array.from(el.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join("|");
    linesFor(el).push(
      `el ${pathOf(el)} ${attrs} text=${ownText} style=${styleText(el)} before=${pseudoText(el, "::before")} after=${pseudoText(el, "::after")}`,
    );
  }

  // A function in a tween's vars (callback, modifier, function-based value)
  // can draw from state the walk cannot read, so it disqualifies the page.
  // An ease is the exception: GSAP calls it with the progress alone, so its
  // curve, sampled, stands in for it. The runtime hands tweens parsed eases.
  const easeCurve = (ease: (progress: number) => unknown): string | null => {
    try {
      const samples = Array.from({ length: 33 }, (_, step) => Number(ease(step / 32)));
      return samples.every(Number.isFinite) ? `ease:${samples.join(",")}` : null;
    } catch {
      return null;
    }
  };
  const serialize = (value: unknown): string =>
    JSON.stringify(value, (key, v) => {
      if (typeof v === "function") {
        const curve = key === "ease" ? easeCurve(v) : null;
        if (curve !== null) return curve;
        reasons.add(`function in tween vars (${key})`);
        return "fn";
      }
      // GSAP keeps live objects in vars (parent timeline, resolved targets).
      const plain = v === null || typeof v !== "object" || Array.isArray(v);
      return plain || Object.getPrototypeOf(v) === Object.prototype ? v : "object";
    });
  // fallow-ignore-next-line complexity
  const walk = (timeline: Tween, offset: number): void => {
    serialize(timeline.vars);
    for (const child of timeline.getChildren?.(false, true, true) ?? []) {
      const start = offset + child.startTime();
      if (typeof child.getChildren === "function") {
        globalLines.push(`timeline start=${start} total=${child.totalDuration()}`);
        walk(child, start);
        continue;
      }
      const record = `tween start=${start} total=${child.totalDuration()} vars=${serialize(child.vars)}`;
      const targets = child.targets?.() ?? [];
      for (const target of targets) {
        if (target instanceof Element) linesFor(target).push(`${record} target=${pathOf(target)}`);
        else globalLines.push(`${record} target=object`);
      }
      if (targets.length === 0) globalLines.push(`${record} target=none`);
    }
  };
  for (const [name, timeline] of Object.entries(win.__timelines ?? {})) {
    if (typeof timeline?.getChildren !== "function") continue;
    globalLines.push(`timeline ${name} total=${timeline.totalDuration()}`);
    walk(timeline, 0);
  }

  const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  if (entries.length >= limits.resourceBuffer) reasons.add("too many loaded resources");
  // Audio does not reach the frames; a video already disqualified the page.
  const resources = [
    ...new Set(
      entries
        .filter((entry) => entry.initiatorType !== "audio" && entry.initiatorType !== "video")
        .map((entry) => entry.name),
    ),
  ].sort();
  if (resources.some((url) => !url.startsWith(`${location.origin}/`))) {
    reasons.add("resource loaded from another origin");
  }

  const sha256 = async (text: string): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  };
  const clips: ClipFingerprint[] = [];
  for (const [index, window] of windows.entries()) {
    clips.push({ ...window, hash: await sha256((lines[index] ?? []).join("\n")) });
  }
  return {
    reasons: [...reasons],
    elements: elements.length,
    global: await sha256(globalLines.join("\n")),
    clips,
    resources,
  };
}

/**
 * Fingerprint the composition loaded in `page`. The page must be seeked to the
 * same time on every render (the caller seeks to frame 0), because computed
 * styles include whatever the animation runtime wrote for that time.
 */
export async function collectClipFingerprints(
  page: Page,
  fetchResource: (url: string) => Promise<Uint8Array>,
): Promise<ClipFingerprintResult> {
  const collected = await page.evaluate(collectInPage, {
    maxElements: MAX_FINGERPRINT_ELEMENTS,
    resourceBuffer: RESOURCE_TIMING_BUFFER,
  });
  if (collected.reasons.length > 0) {
    return { eligible: false, reason: collected.reasons.sort().join(", ") };
  }
  // A file replaced under the same name changes no attribute, so the bytes of
  // everything the page loaded are part of the global fingerprint.
  const global = createHash("sha256").update(collected.global);
  for (const url of collected.resources) {
    global.update(`\n${new URL(url).pathname}\n`).update(await fetchResource(url));
  }
  return {
    eligible: true,
    fingerprints: { global: global.digest("hex"), clips: collected.clips },
    elements: collected.elements,
  };
}

/**
 * Runs of frames predicted identical to the cached render: the global
 * fingerprint matches and no clip that differs between the two renders is
 * active. A clip present in only one render, moved, or with another hash
 * counts as differing over its window in both, widened by one frame each side
 * so a boundary that rounds differently stays on the safe side.
 */
export function predictUnchangedRuns(input: {
  cached: PageFingerprints;
  current: PageFingerprints;
  totalFrames: number;
  fps: Fps;
}): FrameRun[] {
  const { cached, current, totalFrames, fps } = input;
  if (cached.global !== current.global || totalFrames <= 0) return [];
  const keyOf = (clip: ClipFingerprint): string => `${clip.start}:${clip.end}:${clip.hash}`;
  const count = (clips: readonly ClipFingerprint[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const clip of clips) counts.set(keyOf(clip), (counts.get(keyOf(clip)) ?? 0) + 1);
    return counts;
  };
  const cachedCounts = count(cached.clips);
  const currentCounts = count(current.clips);
  const changed = new Uint8Array(totalFrames);
  for (const clip of [...cached.clips, ...current.clips]) {
    if (cachedCounts.get(keyOf(clip)) === currentCounts.get(keyOf(clip))) continue;
    if (!Number.isFinite(clip.start) || !Number.isFinite(clip.end)) return [];
    const first = Math.max(0, Math.floor((clip.start * fps.num) / fps.den) - 1);
    const last = Math.min(totalFrames - 1, Math.ceil((clip.end * fps.num) / fps.den) + 1);
    changed.fill(1, first, last + 1);
  }
  const runs: FrameRun[] = [];
  let runStart: number | null = null;
  for (let frame = 0; frame <= totalFrames; frame++) {
    const unchanged = frame < totalFrames && changed[frame] === 0;
    if (unchanged && runStart === null) runStart = frame;
    else if (!unchanged && runStart !== null) {
      runs.push({ startFrame: runStart, endFrame: frame });
      runStart = null;
    }
  }
  return runs;
}
