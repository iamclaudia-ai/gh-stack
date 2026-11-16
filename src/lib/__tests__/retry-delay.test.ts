// Retry waits and the test override (#108).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { retryDelay, retryWait, TEST_RETRY_DELAY_ENV } from "../retry-delay.ts";

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[TEST_RETRY_DELAY_ENV];
});

afterEach(() => {
  if (saved === undefined) delete process.env[TEST_RETRY_DELAY_ENV];
  else process.env[TEST_RETRY_DELAY_ENV] = saved;
});

describe("retryDelay", () => {
  test("the preload turns waits off for the whole suite", () => {
    expect(saved).toBe("0");
    expect(retryDelay(5000)).toBe(0);
  });

  test("unset: the real delay", () => {
    delete process.env[TEST_RETRY_DELAY_ENV];
    expect(retryDelay(1200)).toBe(1200);
  });

  test("a whole number replaces any delay", () => {
    process.env[TEST_RETRY_DELAY_ENV] = "25";
    expect(retryDelay(1200)).toBe(25);
    expect(retryDelay(0)).toBe(25);
  });

  test("anything else is ignored", () => {
    for (const value of ["", "abc", "-5", "1.5", " 0", "0x10"]) {
      process.env[TEST_RETRY_DELAY_ENV] = value;
      expect(retryDelay(1200)).toBe(1200);
    }
  });
});

describe("retryWait", () => {
  test("waits the override and returns what it waited", async () => {
    process.env[TEST_RETRY_DELAY_ENV] = "30";
    const started = performance.now();
    expect(await retryWait(10_000)).toBe(30);
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
  });

  test("unset: waits the real delay", async () => {
    delete process.env[TEST_RETRY_DELAY_ENV];
    const started = performance.now();
    expect(await retryWait(40)).toBe(40);
    expect(performance.now() - started).toBeGreaterThanOrEqual(35);
  });
});

// A wait that bypasses retryWait would sleep for real in every test that
// reaches it, and nothing would fail: the suite would just get slower again.
describe("waits in src", () => {
  test("all go through retryWait", async () => {
    const root = path.resolve(import.meta.dir, "../..");
    const offenders: string[] = [];
    for (const file of await readdir(root, { recursive: true })) {
      if (!file.endsWith(".ts") || file.includes("__tests__")) continue;
      if (file === path.join("lib", "retry-delay.ts")) continue;
      const lines = (await Bun.file(path.join(root, file)).text()).split("\n");
      lines.forEach((line, i) => {
        if (/Bun\.sleep\(|setTimeout\(/.test(line))
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
