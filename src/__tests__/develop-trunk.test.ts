// #135: a repo whose default branch is neither main nor master. #134 made init
// root stacks on origin's HEAD (`develop` here), but ~25 checks still asked
// `name === "main" || name === "master"`, so they took `develop` for a split
// stack's base: doctor said "base develop is already in develop" and advised
// `restack --onto main`, restack rebased the root onto develop (sync's job),
// and the tree called develop "(base — in parent stack)".
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
  readMetadata,
  writeMetadata,
} from "./helpers.ts";
import { isTrunkName, trunkBranch } from "../lib/git.ts";
import { resolveBaseRef, buildStackViz } from "../commands/update-prs.ts";

let tmpDir: string;
let remoteDir: string;
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

beforeEach(async () => {
  tmpDir = await createTempRepo();
  remoteDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-remote-"));
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await cleanup(tmpDir, remoteDir);
});

describe("a stack in a repo whose default branch is develop", () => {
  // main exists too (gitflow's release branch), but origin's HEAD names
  // develop: develop is the trunk. One stack, `feature`, rooted on it.
  beforeEach(async () => {
    await $`git init --bare -q -b develop ${remoteDir}`.quiet();
    await $`git -C ${tmpDir} remote add origin ${remoteDir}`.quiet();
    await createBranch(tmpDir, "develop", "main");
    await $`git -C ${tmpDir} push -q -u origin main develop`.quiet();
    await $`git -C ${tmpDir} remote set-head origin develop`.quiet();
    await createBranch(tmpDir, "feature", "develop");
    await makeCommit(tmpDir, "feature.txt", "feature\n", "feature: add file");
    const init = await runCli(["init", "--yes"]);
    expect(init.exitCode).toBe(0);
  });

  test("doctor doesn't call develop a merged base or advise re-rooting onto main", async () => {
    const res = await runCli(["doctor"]);
    expect(res.output).not.toContain("is already in develop");
    expect(res.output).not.toContain("restack --onto main");
    expect(res.output).not.toContain("base appears merged");
  });

  // #147: the advice for a stack on a landed branch names the repo's trunk.
  test("doctor advises re-rooting a stack whose base landed onto develop", async () => {
    await createBranch(tmpDir, "child", "feature");
    await makeCommit(tmpDir, "child.txt", "child\n", "child: add file");
    const meta = await readMetadata(tmpDir);
    meta.stacks.child = {
      description: "",
      last_branch: "child",
      base: "feature",
      branches: { child: { parent: "feature" } },
    };
    await writeMetadata(tmpDir, meta);
    // feature lands in develop on origin.
    await $`git -C ${tmpDir} push -q origin feature:develop`.quiet();
    await $`git -C ${tmpDir} fetch -q origin`.quiet();

    const res = await runCli(["doctor"]);
    expect(res.output).toContain("Stacks whose base appears merged into develop:");
    expect(res.output).toContain("Re-root each onto develop once its parent has merged:");
    expect(res.output).toContain("gh-stack restack --onto develop");
    expect(res.output).not.toContain("--onto main");
  });

  test("join's refusal for a branch another stack is built on names develop", async () => {
    await createBranch(tmpDir, "lone", "develop");
    await makeCommit(tmpDir, "lone.txt", "lone\n", "lone: add file");
    await createBranch(tmpDir, "dep", "lone");
    await makeCommit(tmpDir, "dep.txt", "dep\n", "dep: add file");
    const meta = await readMetadata(tmpDir);
    meta.stacks.dep = {
      description: "",
      last_branch: "dep",
      base: "lone",
      branches: { dep: { parent: "lone" } },
    };
    await writeMetadata(tmpDir, meta);
    await checkout(tmpDir, "feature");

    const res = await runCli(["join", "lone", "--no-push", "--yes"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("Stack dep is built on lone");
    expect(res.output).toContain("gh-stack restack --onto develop");
    expect(res.output).not.toContain("--onto main");
  });

  test("restack leaves the root on its spot in develop: moving it is sync's job", async () => {
    // develop moves on locally after the stack was made.
    const before = await getSha(tmpDir, "feature");
    await checkout(tmpDir, "develop");
    await makeCommit(tmpDir, "develop.txt", "develop\n", "develop moves on");
    const developTip = await getSha(tmpDir, "develop");
    await checkout(tmpDir, "feature");

    const res = await runCli(["restack", "--yes", "--no-push"]);
    expect(res.exitCode).toBe(0);
    expect(await getSha(tmpDir, "feature")).toBe(before);
    expect(await isAncestor(tmpDir, developTip, "feature")).toBe(false);
  });

  test("log draws develop as the trunk, not a base in a parent stack", async () => {
    const res = await runCli(["log"]);
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("develop");
    expect(res.output).not.toContain("in parent stack");
  });

  test("the stack's PRs get no 'Don't merge' warning: develop is where they land", async () => {
    process.chdir(tmpDir);
    await trunkBranch();
    expect(isTrunkName("develop")).toBe(true);
    const meta = {
      version: 3 as const,
      current_stack: null,
      stacks: {
        s: {
          description: "",
          last_branch: null,
          base: "develop",
          branches: { feature: { parent: "develop", pr: 7 } },
        },
      },
    };
    const base = await resolveBaseRef(meta, meta.stacks.s, null);
    expect(base).toEqual({ label: "develop" });
    expect(
      buildStackViz(
        [{ branch: "feature", parent: "develop", prNumber: 7, prTitle: "F", prUrl: null }],
        0,
        base,
      ),
    ).not.toContain("Don't merge");
  });
});

describe("trunkBranch fallback", () => {
  test("is origin's master when origin/HEAD isn't set and no local main or master exists", async () => {
    await $`git -C ${tmpDir} branch -M master`.quiet();
    await $`git init --bare -q -b master ${remoteDir}`.quiet();
    await $`git -C ${tmpDir} remote add origin ${remoteDir}`.quiet();
    await $`git -C ${tmpDir} push -q -u origin master`.quiet();
    await $`git -C ${tmpDir} branch -m master work`.quiet();
    process.chdir(tmpDir);
    expect(await trunkBranch()).toBe("master");
  });
});
