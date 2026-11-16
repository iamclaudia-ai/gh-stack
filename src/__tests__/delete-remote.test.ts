// #107: `delete` removes the remote branch through the GitHub API, as
// `merge -d` does, not with `git push --delete`: that push runs the repo's
// pre-push hook, which in many repos is a full lint and test run.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import {
  cleanup,
  createBranch,
  createTempRepo,
  makeCommit,
  PR_BASE_STUB,
  pushAllBranches,
  readMetadata,
  setupRemote,
  writeMetadata,
} from "./helpers.ts";
import type { Stack } from "../types.ts";

setDefaultTimeout(60_000);

let tmpDir: string;
let remoteDir: string;
let stubDir: string;

const cliPath = new URL("../index.ts", import.meta.url).pathname;

/** main → parent → feat/mid → child, stack "deps". The slash checks the ref path. */
const DEPS: Stack = {
  description: "",
  last_branch: "child",
  base: "main",
  branches: {
    parent: { parent: "main", pr: 141 },
    "feat/mid": { parent: "parent", pr: 142 },
    child: { parent: "feat/mid", pr: 143 },
  },
};

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      GH_PR_DIR: stubDir,
      NO_COLOR: "1",
      GH_STACK_NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, out: stdout + stderr };
}

async function refExists(dir: string, ref: string): Promise<boolean> {
  const r = await $`git -C ${dir} rev-parse --verify --quiet ${ref}`.nothrow().quiet();
  return r.exitCode === 0;
}

async function ghCalls(): Promise<string[]> {
  const log = Bun.file(`${stubDir}/calls.log`);
  if (!(await log.exists())) return [];
  return (await log.text()).split("\n").filter(Boolean);
}

/** True when the repo's pre-push hook ran (it records itself, then refuses the push). */
async function hookRan(): Promise<boolean> {
  return Bun.file(`${stubDir}/hook-ran`).exists();
}

beforeEach(async () => {
  tmpDir = await createTempRepo();
  stubDir = await fs.mkdtemp(`${await fs.realpath("/tmp")}/gh-stack-delstub-`);
  await createBranch(tmpDir, "parent", "main");
  await makeCommit(tmpDir, "parent.txt", "parent\n", "parent: commit");
  await createBranch(tmpDir, "feat/mid", "parent");
  await makeCommit(tmpDir, "mid.txt", "mid\n", "mid: commit");
  await createBranch(tmpDir, "child", "feat/mid");
  await makeCommit(tmpDir, "child.txt", "child\n", "child: commit");
  await $`git -C ${tmpDir} checkout -q main`.quiet();
  remoteDir = await setupRemote(tmpDir);
  await pushAllBranches(tmpDir);
  await writeMetadata(tmpDir, { version: 2, current_stack: "deps", stacks: { deps: DEPS } });
  expect((await runCli(["doctor"])).exitCode).toBe(0);

  // A pre-push hook that fails, like a red test suite, and records that it ran.
  // core.hooksPath keeps a global hooksPath from hiding it.
  await fs.mkdir(`${stubDir}/hooks`);
  await Bun.write(`${stubDir}/hooks/pre-push`, `#!/bin/sh\ntouch "${stubDir}/hook-ran"\nexit 1\n`);
  await fs.chmod(`${stubDir}/hooks/pre-push`, 0o755);
  await $`git -C ${tmpDir} config core.hooksPath ${stubDir}/hooks`.quiet();

  // The fake gh: logs each call; $GH_PR_DIR/api.fail makes the API delete fail.
  await Bun.write(
    `${stubDir}/gh`,
    `#!/bin/sh
echo "$*" >> "$GH_PR_DIR/calls.log"
if [ "$1" = "api" ] && [ -f "$GH_PR_DIR/api.fail" ]; then
  echo "gh: Resource not accessible by integration (HTTP 403)" >&2
  exit 1
fi
${PR_BASE_STUB}
exit 1
`,
  );
  await fs.chmod(`${stubDir}/gh`, 0o755);
});

afterEach(async () => {
  await cleanup(tmpDir, remoteDir, stubDir);
});

describe("gh-stack delete, remote branch", () => {
  test("deletes origin's copy through the API, without running the pre-push hook", async () => {
    expect(await refExists(tmpDir, "refs/remotes/origin/feat/mid")).toBe(true);

    const res = await runCli(["delete", "feat/mid", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("Deleted remote branch origin/feat/mid");
    expect(res.out).toContain("Deleted local branch feat/mid");
    expect(await ghCalls()).toContain(
      "api --method DELETE repos/{owner}/{repo}/git/refs/heads/feat/mid",
    );
    expect(await hookRan()).toBe(false);
    expect(await refExists(remoteDir, "refs/heads/feat/mid")).toBe(false);
    // The remote-tracking ref goes too, as with git push --delete.
    expect(await refExists(tmpDir, "refs/remotes/origin/feat/mid")).toBe(false);
    expect(await refExists(tmpDir, "refs/heads/feat/mid")).toBe(false);
    const branches = (await readMetadata(tmpDir)).stacks["deps"]!.branches;
    expect(Object.keys(branches).toSorted()).toEqual(["child", "parent"]);
    expect(branches["child"]!.parent).toBe("parent");
  });

  test("an API failure is reported with gh's message and keeps origin's copy", async () => {
    await Bun.write(`${stubDir}/api.fail`, "");

    const res = await runCli(["delete", "feat/mid", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(res.out).toContain(
      "Could not delete remote branch origin/feat/mid on GitHub (gh: Resource not accessible by integration (HTTP 403))",
    );
    expect(await hookRan()).toBe(false);
    expect(await refExists(remoteDir, "refs/heads/feat/mid")).toBe(true);
    expect(await refExists(tmpDir, "refs/remotes/origin/feat/mid")).toBe(true);
    // The local branch and the metadata go regardless, as before.
    expect(await refExists(tmpDir, "refs/heads/feat/mid")).toBe(false);
    expect(Object.keys((await readMetadata(tmpDir)).stacks["deps"]!.branches)).not.toContain(
      "feat/mid",
    );
  });

  test("--no-remote leaves origin alone and never calls the API", async () => {
    const res = await runCli(["delete", "feat/mid", "--no-remote", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect((await ghCalls()).filter((c) => c.startsWith("api"))).toEqual([]);
    expect(await refExists(remoteDir, "refs/heads/feat/mid")).toBe(true);
    expect(await refExists(tmpDir, "refs/remotes/origin/feat/mid")).toBe(true);
    expect(await refExists(tmpDir, "refs/heads/feat/mid")).toBe(false);
  });
});
