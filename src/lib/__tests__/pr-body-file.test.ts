// #174: updatePrBody passed the description through $TMPDIR/gh-stack-pr-body-<N>.md,
// a name shared by every gh-stack run. Two runs editing a PR with the same
// number (two repos, or parallel tests) posted each other's description, and
// the second cleanup failed, reporting a successful edit as failed.
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const githubTs = new URL("../github.ts", import.meta.url).pathname;
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "gh-stack-pr-body-test-"));
  await fs.mkdir(join(dir, "bin"));
  await fs.mkdir(join(dir, "tmp"));
  await fs.mkdir(join(dir, "read"));
  // `gh pr edit N --body-file F` waits, so both calls have written their file
  // before either is read, then keeps what it read.
  await Bun.write(
    join(dir, "bin", "gh"),
    `#!/bin/sh
[ "$1 $2 $4" = "pr edit --body-file" ] || exit 1
[ -n "$GH_FAIL" ] && exit 1
sleep 0.3
cat "$5" > "${dir}/read/$$"
`,
  );
  await fs.chmod(join(dir, "bin", "gh"), 0o755);
  await Bun.write(
    join(dir, "run.ts"),
    `import { updatePrBody } from ${JSON.stringify(githubTs)};
const oks = await Promise.all([updatePrBody(101, "body A"), updatePrBody(101, "body B")]);
console.log(JSON.stringify(oks));
`,
  );
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Run run.ts with the fake gh first on PATH and TMPDIR inside the test dir; its results. */
async function runEdits(env: Record<string, string> = {}): Promise<boolean[]> {
  const proc = Bun.spawn(["bun", "run", join(dir, "run.ts")], {
    env: {
      ...process.env,
      PATH: `${dir}/bin:${process.env.PATH}`,
      TMPDIR: join(dir, "tmp"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return JSON.parse(stdout) as boolean[];
}

test("two edits of the same PR number at once each send their own body, and both succeed", async () => {
  expect(await runEdits()).toEqual([true, true]);
  const reads = await fs.readdir(join(dir, "read"));
  const bodies = await Promise.all(reads.map((f) => Bun.file(join(dir, "read", f)).text()));
  expect(bodies.toSorted()).toEqual(["body A", "body B"]);
  // Nothing left behind in the temp dir.
  expect(await fs.readdir(join(dir, "tmp"))).toEqual([]);
});

test("a failed edit reports false and leaves nothing behind", async () => {
  expect(await runEdits({ GH_FAIL: "1" })).toEqual([false, false]);
  expect(await fs.readdir(join(dir, "tmp"))).toEqual([]);
});
