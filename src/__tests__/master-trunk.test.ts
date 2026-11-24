// #134: a repo whose trunk is `master`. init rooted the stack on a literal
// `main` (absent there), so chain detection adopted a stale `develop`, and sync
// fetched `origin main` whatever the stack's base was. The trunk now comes from
// origin's HEAD (the repo's default branch), and sync and merge work on the
// stack's base.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  checkout,
  cleanup,
  createBranch,
  createTempRepo,
  getSha,
  isAncestor,
  makeCommit,
} from "./helpers.ts";
import { trunkBranch } from "../lib/git.ts";

let tmpDir: string;
let remoteDir: string;
let otherDir: string;
let originalCwd: string;

const cliPath = new URL("../index.ts", import.meta.url).pathname;

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", cliPath, ...args], {
    cwd: tmpDir,
    env: { ...process.env, NO_COLOR: "1", GH_STACK_NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr, output: stdout + stderr };
}

/** A repo on `master`, with a bare origin whose HEAD names master. */
async function masterRepo(): Promise<void> {
  await $`git -C ${tmpDir} branch -M master`.quiet();
  await $`git init --bare -q -b master ${remoteDir}`.quiet();
  await $`git -C ${tmpDir} remote add origin ${remoteDir}`.quiet();
  await $`git -C ${tmpDir} push -q -u origin master`.quiet();
  await $`git -C ${tmpDir} remote set-head origin master`.quiet();
}

beforeEach(async () => {
  tmpDir = await createTempRepo();
  remoteDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-remote-"));
  otherDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-other-"));
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await cleanup(tmpDir, remoteDir, otherDir);
});

describe("trunkBranch", () => {
  test("is the branch origin's HEAD names, even beside a stale local main", async () => {
    await masterRepo();
    await createBranch(tmpDir, "main", "master"); // stale leftover
    process.chdir(tmpDir);
    expect(await trunkBranch()).toBe("master");
  });

  test("falls back to master when origin's HEAD isn't set and only master exists", async () => {
    await $`git -C ${tmpDir} branch -M master`.quiet();
    process.chdir(tmpDir);
    expect(await trunkBranch()).toBe("master");
  });

  test("is main in a plain repo on main", async () => {
    process.chdir(tmpDir);
    expect(await trunkBranch()).toBe("main");
  });
});

describe("a stack in a repo on master", () => {
  beforeEach(async () => {
    await masterRepo();
    // A stale branch sitting on master's history: not part of any chain.
    await createBranch(tmpDir, "develop", "master");
    await checkout(tmpDir, "master");
    await createBranch(tmpDir, "feature", "master");
    await makeCommit(tmpDir, "feature.txt", "feature\n", "feature: add file");
  });

  test("init roots the stack on master and leaves develop out", async () => {
    const res = await runCli(["init", "--yes"]);
    expect(res.exitCode).toBe(0);

    const { stacks } = JSON.parse((await runCli(["stacks", "--json"])).stdout);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].base).toBe("master");
    expect(stacks[0].branches.map((b: { branch: string }) => b.branch)).toEqual(["feature"]);
    expect(stacks[0].branches[0].parent).toBe("master");
  });

  test("sync fetches origin/master and rebases the stack onto it", async () => {
    expect((await runCli(["init", "--yes"])).exitCode).toBe(0);

    // master moves on origin, from another clone.
    await $`git clone -q ${remoteDir} ${otherDir}`.quiet();
    await $`git -C ${otherDir} config user.email test@test.com`.quiet();
    await $`git -C ${otherDir} config user.name Test`.quiet();
    await makeCommit(otherDir, "upstream.txt", "upstream\n", "upstream change");
    await $`git -C ${otherDir} push -q origin master`.quiet();
    const upstream = await getSha(otherDir, "HEAD");

    const res = await runCli(["sync", "--yes", "--no-push"]);
    expect(res.output).not.toContain("couldn't find remote ref main");
    expect(res.exitCode).toBe(0);
    expect(await isAncestor(tmpDir, upstream, "feature")).toBe(true);
  });
});
