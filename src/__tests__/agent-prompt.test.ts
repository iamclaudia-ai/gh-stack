// #123: an agent's shell can be a tmux pane, where stdin IS a TTY but nobody
// types. A prompt reached there must exit at once, like one without a TTY
// (#33), instead of hanging until the agent's tool timeout kills it.
//
// These tests run the CLI on a real pseudo-terminal (Bun.spawn's `terminal`
// option), so `process.stdin.isTTY` is true in the child, as in a tmux pane.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { agentMarker } from "../lib/output.ts";
import { checkout, cleanup, createLinearStack, createTempRepo, makeCommit } from "./helpers.ts";

const cliPath = new URL("../index.ts", import.meta.url).pathname;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTempRepo();
});

afterEach(async () => {
  await cleanup(tmpDir);
});

/** pr1 → pr2 → pr3, then a new commit on pr1, so a restack from pr1 prompts to rebase pr2. */
async function stackNeedingRestack(): Promise<void> {
  await createLinearStack(tmpDir);
  await checkout(tmpDir, "pr1");
  await makeCommit(tmpDir, "pr1-fix.txt", "fix\n", "fix on pr1");
}

interface PtyRun {
  exitCode: number | null;
  output: string;
  /** True when the run outlived its deadline and was killed: a hang. */
  timedOut: boolean;
}

/**
 * Run the CLI on a pseudo-terminal with exactly `env`'s agent markers. When
 * `whenOutput` matches, `reply` is typed into the terminal.
 */
async function runInPty(
  args: string[],
  env: Record<string, string>,
  opts: { whenOutput?: RegExp; reply?: string; deadlineMs?: number } = {},
): Promise<PtyRun> {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  for (const name of ["CLAUDECODE", "ANIMA_SESSION_ID", "GH_STACK_YES", "GH_STACK_NO_PUSH"]) {
    delete baseEnv[name];
  }
  let output = "";
  let replied = false;
  const decoder = new TextDecoder();
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: { ...baseEnv, NO_COLOR: "1", GH_STACK_NO_COLOR: "1", ...env },
    terminal: {
      cols: 120,
      rows: 40,
      data(term, data) {
        output += decoder.decode(data, { stream: true });
        if (!replied && opts.whenOutput?.test(output) && opts.reply !== undefined) {
          replied = true;
          term.write(opts.reply);
        }
      },
    },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.deadlineMs ?? 15_000);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  proc.terminal?.close();
  return { exitCode: timedOut ? null : exitCode, output, timedOut };
}

async function sha(ref: string): Promise<string> {
  return (await $`git -C ${tmpDir} rev-parse ${ref}`.text()).trim();
}

describe("prompts from an agent's terminal (#123)", () => {
  test("CLAUDECODE on a TTY refuses the prompt instead of waiting", async () => {
    await stackNeedingRestack();
    const pr2 = await sha("pr2");

    const res = await runInPty(["restack", "--no-push"], { CLAUDECODE: "1" });

    expect(res.timedOut).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain("refusing to prompt");
    expect(res.output).toContain("CLAUDECODE is set");
    expect(res.output).toContain("Prompt: Rebase pr2 onto pr1?");
    expect(res.output).toContain("GH_STACK_YES=1");
    expect(await sha("pr2")).toBe(pr2);
  });

  test("ANIMA_SESSION_ID alone (a Codex session) refuses too", async () => {
    await stackNeedingRestack();

    const res = await runInPty(["restack", "--no-push"], { ANIMA_SESSION_ID: "session-123" });

    expect(res.timedOut).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain("ANIMA_SESSION_ID is set");
  });

  test("a person's terminal still gets the prompt", async () => {
    await stackNeedingRestack();
    const pr2 = await sha("pr2");

    // Ctrl-C cancels the prompt once it shows, so a working prompt ends the run.
    const res = await runInPty(
      ["restack", "--no-push"],
      {},
      { whenOutput: /Rebase pr2 onto pr1\?/, reply: "\x03" },
    );

    expect(res.timedOut).toBe(false);
    expect(res.output).toContain("Rebase pr2 onto pr1?");
    expect(res.output).not.toContain("refusing to prompt");
    expect(await sha("pr2")).toBe(pr2);
  });

  test("GH_STACK_YES still runs an agent's restack without asking", async () => {
    await stackNeedingRestack();
    const pr2 = await sha("pr2");

    const res = await runInPty(["restack", "--no-push"], { CLAUDECODE: "1", GH_STACK_YES: "1" });

    expect(res.timedOut).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(res.output).not.toContain("refusing to prompt");
    expect(await sha("pr2")).not.toBe(pr2);
  });
});

describe("agentMarker", () => {
  test("names the variable that marks an agent, CLAUDECODE first", () => {
    expect(agentMarker({ CLAUDECODE: "1", ANIMA_SESSION_ID: "s" })).toBe("CLAUDECODE");
    expect(agentMarker({ ANIMA_SESSION_ID: "s" })).toBe("ANIMA_SESSION_ID");
  });

  test("an empty or missing variable is a person's shell", () => {
    expect(agentMarker({})).toBeUndefined();
    expect(agentMarker({ CLAUDECODE: "", ANIMA_SESSION_ID: "" })).toBeUndefined();
  });
});
