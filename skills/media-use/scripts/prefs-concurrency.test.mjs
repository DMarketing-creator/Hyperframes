import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SCRIPTS = dirname(fileURLToPath(import.meta.url));

// Isolate the user tier (recordUserSighting writes ~/.media) per case.
function isolatedHome() {
  const home = mkdtempSync(join(tmpdir(), "media-use-prefs-home-"));
  process.env.HYPERFRAMES_MEDIA_HOME = home;
  return home;
}

function record(scriptsDir, projectDir, key, value) {
  return execFileAsync(process.execPath, [
    join(scriptsDir, "prefs.mjs"),
    "record",
    "--hyperframes",
    projectDir,
    "--key",
    key,
    "--value",
    value,
  ]);
}

test("parallel record calls all succeed and keep every key (#5333)", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "media-use-prefs-race-"));
  const home = isolatedHome();
  t.after(() => {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const projectDir = join(scratch, "project");
  const pairs = [
    ["destination", "youtube-shorts"],
    ["aspect", "1080x1920"],
    ["language", "en"],
    ["flow", "automation"],
  ];
  const results = await Promise.all(
    pairs.map(([key, value]) => record(SCRIPTS, projectDir, key, value)),
  );
  for (const result of results) {
    assert.equal(result.stderr, "");
  }
  const stored = JSON.parse(
    readFileSync(join(projectDir, ".media", "preferences.json"), "utf8"),
  );
  for (const [key, value] of pairs) {
    assert.equal(stored.preferences[key]?.value, value, `kept ${key}`);
  }
});

test("sequential records accumulate instead of overwriting", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "media-use-prefs-seq-"));
  const home = isolatedHome();
  t.after(() => {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const projectDir = join(scratch, "project");
  await record(SCRIPTS, projectDir, "destination", "youtube-shorts");
  await record(SCRIPTS, projectDir, "aspect", "1080x1920");
  const stored = JSON.parse(
    readFileSync(join(projectDir, ".media", "preferences.json"), "utf8"),
  );
  assert.equal(stored.preferences.destination?.value, "youtube-shorts");
  assert.equal(stored.preferences.aspect?.value, "1080x1920");
});
