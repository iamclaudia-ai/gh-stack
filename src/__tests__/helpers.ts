// Shared test helpers for creating temp git repos and stacks
import { $ } from "bun";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { StackMetadata } from "../types.ts";

// ── Templates (#138) ──
//
// The suite's cost is git process count, not disk (~31k git processes per run,
// 62% of them from these fixtures). A fresh repo took six (init, two config
// writes, add, commit, branch -M) and the 3-branch stacks another eleven, so
// each is built once, with the same git commands, and copied per call. A copy
// keeps git's own reflogs (restack reads them, #83). The index's stat info goes
// stale with the copy's new mtimes, which git notices and re-checks, so the
// tree stays clean. Copies share their commits' shas, as repos made within the
// same second did.
//
// Templates are shared by every test process and run: parallel workers run
// each file in its own process (--isolate) and exit without "exit" handlers,
// so per-process templates were left behind. A process that finds a template
// missing builds it in a dir of its own and renames that into place; rename is
// atomic, so a template that exists is complete, and when two processes race,
// the loser drops its copy. The names carry a hash of this file, so editing a
// recipe starts new templates instead of reusing stale ones.
//
// They live in node_modules/.cache, not /tmp: macOS deletes /tmp files nobody
// has read for three days, which would leave a template's dirs standing with
// its files gone, and a template that exists is trusted.

const TEMPLATE_ROOT = path.join(
  import.meta.dir,
  "../../node_modules/.cache/gh-stack-test-templates",
);

let recipeHash: Promise<string> | undefined;
const builtTemplates = new Map<string, Promise<string>>();

async function sharedTemplate(
  name: string,
  build: (dir: string) => Promise<void>,
): Promise<string> {
  let template = builtTemplates.get(name);
  if (!template) {
    template = buildSharedTemplate(name, build);
    builtTemplates.set(name, template);
  }
  return template;
}

async function buildSharedTemplate(
  name: string,
  build: (dir: string) => Promise<void>,
): Promise<string> {
  recipeHash ??= Bun.file(import.meta.path)
    .text()
    .then((source) => Bun.hash(source).toString(36));
  const target = path.join(TEMPLATE_ROOT, `${await recipeHash}-${name}`);
  if (await exists(target)) return target;

  await fs.mkdir(TEMPLATE_ROOT, { recursive: true });
  const work = await fs.mkdtemp(path.join(TEMPLATE_ROOT, "build-"));
  try {
    await build(work);
  } catch (error) {
    await fs.rm(work, { recursive: true, force: true });
    throw error;
  }
  try {
    await fs.rename(work, target);
  } catch {
    // Another process got there first (the target exists and isn't empty).
    await fs.rm(work, { recursive: true, force: true });
  }
  return target;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function repoTemplate(): Promise<string> {
  return sharedTemplate("repo", async (dir) => {
    await $`git init ${dir}`.quiet();
    await $`git -C ${dir} config user.email "test@test.com"`.quiet();
    await $`git -C ${dir} config user.name "Test"`.quiet();
    await Bun.write(`${dir}/README.md`, "# Test Repo\n");
    await $`git -C ${dir} add .`.quiet();
    await $`git -C ${dir} commit -m "initial commit"`.quiet();
    await $`git -C ${dir} branch -M main`.quiet();
  });
}

async function copyInto(template: string, dir: string): Promise<void> {
  await fs.cp(template, dir, { recursive: true });
}

/**
 * Create a temp git repo with an initial commit on main.
 * Returns the directory path. Caller must clean up.
 */
export async function createTempRepo(): Promise<string> {
  const template = await repoTemplate();
  const dir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-test-"));
  await copyInto(template, dir);
  return dir;
}

/** Every path under `root`, sorted, with its type and mode, and each file's bytes. */
async function readTree(root: string): Promise<{ paths: string; files: Map<string, Buffer> }> {
  const entries = (await fs.readdir(root, { recursive: true })).toSorted();
  const files = new Map<string, Buffer>();
  const lines: string[] = [];
  for (const rel of entries) {
    const stat = await fs.lstat(`${root}/${rel}`);
    lines.push(`${rel} ${stat.mode.toString(8)}`);
    if (stat.isFile()) files.set(rel, await fs.readFile(`${root}/${rel}`));
  }
  return { paths: lines.join("\n"), files };
}

let repoTemplateTree: Promise<Awaited<ReturnType<typeof readTree>>> | undefined;

/**
 * Whether `dir` is still byte for byte what createTempRepo made (every file
 * under it, .git included, with the same modes), so a stack template can
 * replace its .git without losing anything a test set up. A suite run had 200
 * untouched repos here, every one identical to the template, index included.
 */
async function isUntouchedRepo(dir: string): Promise<boolean> {
  repoTemplateTree ??= repoTemplate().then(readTree);
  const template = await repoTemplateTree;
  const actual = await readTree(dir);
  if (actual.paths !== template.paths) return false;
  for (const [rel, bytes] of actual.files) {
    if (!bytes.equals(template.files.get(rel)!)) return false;
  }
  return true;
}

/**
 * Build a stack in `dir` from a template when `dir` is untouched; otherwise
 * run the recipe in it. Returns the branches' shas either way.
 */
async function stackFromTemplate(
  dir: string,
  name: string,
  recipe: (dir: string) => Promise<void>,
  branches: string[],
): Promise<Record<string, string>> {
  if (await isUntouchedRepo(dir)) {
    const template = await sharedTemplate(name, async (work) => {
      await copyInto(await repoTemplate(), work);
      await recipe(work);
    });
    await fs.rm(`${dir}/.git`, { recursive: true, force: true });
    await copyInto(template, dir);
  } else {
    await recipe(dir);
  }
  const shas: Record<string, string> = {};
  for (const branch of branches) shas[branch] = await branchSha(dir, branch);
  return shas;
}

/** A branch's sha from its loose ref file, or from git when it isn't one. */
async function branchSha(dir: string, branch: string): Promise<string> {
  try {
    const sha = (await fs.readFile(`${dir}/.git/refs/heads/${branch}`, "utf8")).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  } catch {
    // fall through to git
  }
  return getSha(dir, `refs/heads/${branch}`);
}

/**
 * The sha HEAD points at, read from the ref files when HEAD is a loose branch
 * ref or detached in a plain repo. Anything else (a linked worktree's .git
 * file, a packed ref) asks git.
 */
async function headSha(dir: string): Promise<string> {
  try {
    const head = (await fs.readFile(`${dir}/.git/HEAD`, "utf8")).trim();
    const sha = head.startsWith("ref: ")
      ? (await fs.readFile(`${dir}/.git/${head.slice(5)}`, "utf8")).trim()
      : head;
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  } catch {
    // fall through to git
  }
  return (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
}

/**
 * Create a commit on the current branch in a temp repo.
 */
export async function makeCommit(
  dir: string,
  filename: string,
  content: string,
  message: string,
): Promise<string> {
  await Bun.write(`${dir}/${filename}`, content);
  await $`git -C ${dir} add ${filename}`.quiet();
  await $`git -C ${dir} commit -m ${message}`.quiet();
  return headSha(dir);
}

/**
 * Create a branch in a temp repo (off `from`, or HEAD) and check it out.
 */
export async function createBranch(dir: string, name: string, from?: string): Promise<void> {
  if (from) {
    await $`git -C ${dir} checkout -b ${name} ${from}`.quiet();
  } else {
    await $`git -C ${dir} checkout -b ${name}`.quiet();
  }
}

/**
 * Checkout a branch in a temp repo.
 */
export async function checkout(dir: string, branch: string): Promise<void> {
  await $`git -C ${dir} checkout ${branch}`.quiet();
}

/**
 * Get current branch in a temp repo.
 */
export async function getCurrentBranch(dir: string): Promise<string> {
  return (await $`git -C ${dir} rev-parse --abbrev-ref HEAD`.text()).trim();
}

/**
 * Get SHA of a ref in a temp repo.
 */
export async function getSha(dir: string, ref: string): Promise<string> {
  return (await $`git -C ${dir} rev-parse ${ref}`.text()).trim();
}

/**
 * Check if ref1 is ancestor of ref2.
 */
export async function isAncestor(
  dir: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const { exitCode } = await $`git -C ${dir} merge-base --is-ancestor ${ancestor} ${descendant}`
    .nothrow()
    .quiet();
  return exitCode === 0;
}

// ── v3 metadata layout (mirrors src/lib/metadata.ts + paths.ts) ──
//
// Tests run the real CLI against temp repos, so the helper has to produce the
// same on-disk shape the CLI reads: per-stack files under .git/.gh-stack/,
// plus a `current` hint. Branch config is intentionally NOT written here — the
// CLI reconciles it on the next write, and reads assemble topology from files.

function ghStackBase(dir: string): string {
  return `${dir}/.git/.gh-stack`;
}

function stackFileName(name: string): string {
  return `${encodeURIComponent(name)}.json`;
}

function stackNameFromFile(file: string): string {
  return decodeURIComponent(file.replace(/\.json$/, ""));
}

function serializeStack(stack: StackMetadata["stacks"][string]): string {
  return (
    JSON.stringify(
      {
        description: stack.description,
        last_branch: stack.last_branch,
        base: stack.base ?? "main",
        branches: stack.branches,
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Write metadata directly to a temp repo in the v3 on-disk layout.
 */
export async function writeMetadata(dir: string, meta: StackMetadata): Promise<void> {
  const base = ghStackBase(dir);
  await fs.mkdir(`${base}/active`, { recursive: true });
  await fs.mkdir(`${base}/archived`, { recursive: true });
  await fs.mkdir(`${base}/snapshots`, { recursive: true });

  await Bun.write(`${base}/current`, (meta.current_stack ?? "") + "\n");

  for (const [name, stack] of Object.entries(meta.stacks)) {
    await Bun.write(`${base}/active/${stackFileName(name)}`, serializeStack(stack));
  }
  for (const [name, stack] of Object.entries(meta.archive ?? {})) {
    await Bun.write(`${base}/archived/${stackFileName(name)}`, serializeStack(stack));
  }
  for (const snap of meta.snapshots ?? []) {
    const ts = snap.timestamp.replace(/[:.]/g, "-");
    const fname = `${ts}__${encodeURIComponent(snap.stack ?? "")}.json`;
    await Bun.write(`${base}/snapshots/${fname}`, JSON.stringify(snap, null, 2) + "\n");
  }
}

async function readStackDir(dir: string): Promise<StackMetadata["stacks"]> {
  const out: StackMetadata["stacks"] = {};
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    out[stackNameFromFile(file)] = await Bun.file(`${dir}/${file}`).json();
  }
  return out;
}

/**
 * Read metadata from a temp repo, assembling the v3 layout into the in-memory
 * shape (matches what the CLI's readMetadata returns).
 */
export async function readMetadata(dir: string): Promise<StackMetadata> {
  const base = ghStackBase(dir);

  let current: string | null = null;
  try {
    const text = (await Bun.file(`${base}/current`).text()).trim();
    current = text.length > 0 ? text : null;
  } catch {
    current = null;
  }

  const stacks = await readStackDir(`${base}/active`);
  const archive = await readStackDir(`${base}/archived`);

  const loaded: NonNullable<StackMetadata["snapshots"]> = [];
  try {
    for (const file of await fs.readdir(`${base}/snapshots`)) {
      if (!file.endsWith(".json")) continue;
      loaded.push(await Bun.file(`${base}/snapshots/${file}`).json());
    }
  } catch {
    // no snapshots dir
  }
  const snapshots = loaded.toSorted((a, b) => a.timestamp.localeCompare(b.timestamp));

  const meta: StackMetadata = { version: 3, current_stack: current, stacks };
  if (Object.keys(archive).length > 0) meta.archive = archive;
  if (snapshots.length > 0) meta.snapshots = snapshots;
  return meta;
}

/**
 * Check if v3 metadata exists in a temp repo.
 */
export async function metadataExists(dir: string): Promise<boolean> {
  try {
    await fs.stat(ghStackBase(dir));
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a standard 3-branch linear stack:
 *   main → pr1 → pr2 → pr3
 *
 * Each branch has one unique commit (different files, no conflicts).
 * Returns the metadata and branch SHAs.
 */
export async function createLinearStack(
  dir: string,
  opts?: { conflicting?: boolean },
): Promise<{
  meta: StackMetadata;
  shas: Record<string, string>;
}> {
  const name = opts?.conflicting ? "linear-conflicting" : "linear";
  const shas = await stackFromTemplate(dir, name, (d) => linearStackRecipe(d, opts), [
    "main",
    "pr1",
    "pr2",
    "pr3",
  ]);
  return { meta: linearStackMeta(), shas };
}

async function linearStackRecipe(dir: string, opts?: { conflicting?: boolean }): Promise<void> {
  // PR1: branch off main
  await createBranch(dir, "pr1", "main");
  if (opts?.conflicting) {
    await makeCommit(dir, "shared.txt", "pr1 version\n", "pr1: shared file");
  } else {
    await makeCommit(dir, "pr1.txt", "pr1 content\n", "pr1: add file");
  }

  // PR2: branch off pr1
  await createBranch(dir, "pr2", "pr1");
  await makeCommit(dir, "pr2.txt", "pr2 content\n", "pr2: add file");

  // PR3: branch off pr2
  await createBranch(dir, "pr3", "pr2");
  await makeCommit(dir, "pr3.txt", "pr3 content\n", "pr3: add file");

  await writeMetadata(dir, linearStackMeta());

  // Go back to main
  await checkout(dir, "main");
}

function linearStackMeta(): StackMetadata {
  return {
    version: 2,
    current_stack: "test-stack",
    stacks: {
      "test-stack": {
        description: "Test stack",
        last_branch: "pr3",
        branches: {
          pr1: { parent: "main", pr: 1, description: "PR 1" },
          pr2: { parent: "pr1", pr: 2, description: "PR 2" },
          pr3: { parent: "pr2", pr: 3, description: "PR 3" },
        },
      },
    },
  };
}

/**
 * Create a branching (tree) stack:
 *   main → pr1 → pr2a
 *               → pr2b → pr3
 */
export async function createBranchingStack(dir: string): Promise<{
  meta: StackMetadata;
  shas: Record<string, string>;
}> {
  const shas = await stackFromTemplate(dir, "branching", branchingStackRecipe, [
    "main",
    "pr1",
    "pr2a",
    "pr2b",
    "pr3",
  ]);
  return { meta: branchingStackMeta(), shas };
}

async function branchingStackRecipe(dir: string): Promise<void> {
  // PR1: branch off main
  await createBranch(dir, "pr1", "main");
  await makeCommit(dir, "pr1.txt", "pr1 content\n", "pr1: add file");

  // PR2a: branch off pr1
  await createBranch(dir, "pr2a", "pr1");
  await makeCommit(dir, "pr2a.txt", "pr2a content\n", "pr2a: add file");

  // PR2b: branch off pr1
  await createBranch(dir, "pr2b", "pr1");
  await makeCommit(dir, "pr2b.txt", "pr2b content\n", "pr2b: add file");

  // PR3: branch off pr2b
  await createBranch(dir, "pr3", "pr2b");
  await makeCommit(dir, "pr3.txt", "pr3 content\n", "pr3: add file");

  await writeMetadata(dir, branchingStackMeta());
  await checkout(dir, "main");
}

function branchingStackMeta(): StackMetadata {
  return {
    version: 2,
    current_stack: "tree-stack",
    stacks: {
      "tree-stack": {
        description: "Tree stack",
        last_branch: "pr3",
        branches: {
          pr1: { parent: "main", pr: 1, description: "PR 1" },
          pr2a: { parent: "pr1", pr: 2, description: "PR 2a" },
          pr2b: { parent: "pr1", pr: 3, description: "PR 2b" },
          pr3: { parent: "pr2b", pr: 4, description: "PR 3" },
        },
      },
    },
  };
}

/**
 * Add a commit to main that will conflict with a branch.
 */
export async function addConflictingMainCommit(
  dir: string,
  filename: string = "shared.txt",
  content: string = "main version\n",
): Promise<string> {
  await checkout(dir, "main");
  return makeCommit(dir, filename, content, "main: conflicting change");
}

/**
 * Simulate an "origin/main" by creating a bare remote and pushing.
 */
export async function setupRemote(dir: string): Promise<string> {
  const bare = await sharedTemplate("bare", async (d) => {
    await $`git init --bare ${d}`.quiet();
  });
  const remoteDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-remote-"));
  await copyInto(bare, remoteDir);
  await $`git -C ${dir} remote add origin ${remoteDir}`.quiet();
  await $`git -C ${dir} push -u origin main`.quiet();
  return remoteDir;
}

/**
 * Push all branches to remote, each with its upstream set. One push: a
 * rejected branch doesn't stop the others, as one push per branch didn't.
 */
export async function pushAllBranches(dir: string): Promise<void> {
  await $`git -C ${dir} push -u origin --all`.quiet().nothrow();
}

/**
 * Clean up a temp directory.
 */
export async function cleanup(...dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ── Stub `gh` ──

// A fake `gh` for end-to-end submit tests, answering the calls submit makes.
// `pr list` finds no PRs (except the one named by GH_EXISTING_PR), `pr create`
// hands out PR numbers from 101 up (or fails when GH_FAIL_CREATE is set),
// description edits fail when GH_FAIL_BODY_EDIT is set, and every call is
// appended to $GH_LOG.
const GH_STUB = `#!/bin/sh
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "repo view") echo "acme/widgets" ;;
  "pr list")
    # GH_EXISTING_PR=<branch>=<number>: that branch already has a PR.
    head=""; prev=""
    for a in "$@"; do [ "$prev" = "--head" ] && head="$a"; prev="$a"; done
    if [ -n "$GH_EXISTING_PR" ] && [ "\${GH_EXISTING_PR%%=*}" = "$head" ]; then
      echo "\${GH_EXISTING_PR#*=}"
    fi
    ;;
  "pr create")
    if [ -n "$GH_FAIL_CREATE" ]; then echo "GraphQL: something broke" >&2; exit 1; fi
    n=$(cat "$GH_STATE" 2>/dev/null || echo 100)
    n=$((n + 1))
    echo "$n" > "$GH_STATE"
    echo "https://github.com/acme/widgets/pull/$n"
    ;;
  "pr view")
    # GH_PR_VIEW_DIR/<n>.json answers \`gh pr view <n>\`; <n>.fail fails it every
    # time with the file's text on stderr; <n>.flaky fails it once, then is removed.
    d="$GH_PR_VIEW_DIR"
    if [ -n "$d" ] && [ -f "$d/$3.flaky" ]; then cat "$d/$3.flaky" >&2; rm "$d/$3.flaky"; exit 1; fi
    if [ -n "$d" ] && [ -f "$d/$3.fail" ]; then cat "$d/$3.fail" >&2; exit 1; fi
    if [ -n "$d" ] && [ -f "$d/$3.json" ]; then cat "$d/$3.json"; exit 0; fi
    # Description reads (getPrBody) get an empty body, as they always have.
    case "$*" in *"--json body"*) exit 0 ;; esac
    echo "GraphQL: Could not resolve to a PullRequest with the number of $3. (repository.pullRequest)" >&2
    exit 1
    ;;
  "pr edit")
    # GH_KILL_ON_EDIT: gh-stack dies here, after creating PRs, before its last write.
    [ -n "$GH_KILL_ON_EDIT" ] && kill -9 $PPID
    case "$*" in *--body-file*) [ -n "$GH_FAIL_BODY_EDIT" ] && exit 1 ;; esac
    # GH_BODY_DIR/<n>.md keeps the last description \`gh pr edit <n> --body-file f\` sent.
    case "$*" in *--body-file*) [ -n "$GH_BODY_DIR" ] && cp "$5" "$GH_BODY_DIR/$3.md" ;; esac
    ;;
esac
exit 0
`;

/** Write the stub `gh` to a new temp dir and return the dir (prepend it to PATH). */
export async function createGhStub(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "gh-stack-ghstub-"));
  await Bun.write(`${dir}/gh`, GH_STUB);
  await fs.chmod(`${dir}/gh`, 0o755);
  return dir;
}

/** Env for a CLI run against the stub: gh on PATH, its call log and PR counter. */
export function ghStubEnv(stubDir: string): Record<string, string> {
  return {
    PATH: `${stubDir}:${process.env.PATH}`,
    GH_LOG: `${stubDir}/calls.log`,
    GH_STATE: `${stubDir}/next-pr`,
  };
}

/**
 * The PR-base part of the fake gh (#100): `pr list --base B` prints the open
 * PRs whose N.json has base B, `pr edit N --base B` records B in N.json (and
 * fails while $GH_PR_DIR/edit-N.fails counts down), and the API delete of
 * `git/refs/heads/<b>` deletes <b> in origin's bare repo. Like the real API, it
 * runs no pre-push hook and leaves the local refs/remotes/origin/<b> alone.
 */
export const PR_BASE_STUB = `if [ "$1 $2" = "pr list" ]; then
  base=""; prev=""
  for a in "$@"; do [ "$prev" = "--base" ] && base="$a"; prev="$a"; done
  for f in "$GH_PR_DIR"/[0-9]*.json; do
    grep -q '"state":"OPEN"' "$f" && grep -q '"baseRefName":"'"$base"'"' "$f" && basename "$f" .json
  done
  exit 0
fi
if [ "$1 $2" = "pr edit" ]; then
  fails="$GH_PR_DIR/edit-$3.fails"
  if [ -f "$fails" ] && [ "$(cat "$fails")" -gt 0 ]; then
    echo $(( $(cat "$fails") - 1 )) > "$fails"
    echo "GraphQL: Something went wrong (updatePullRequest)" >&2
    exit 1
  fi
  if [ "$4" = "--base" ]; then
    j="$GH_PR_DIR/$3.json"
    sed 's/"baseRefName":"[^"]*"/"baseRefName":"'"$5"'"/' "$j" > "$j.tmp" && mv "$j.tmp" "$j"
  fi
  exit 0
fi
if [ "$1 $2 $3" = "api --method DELETE" ]; then
  git -C "$(git remote get-url origin)" update-ref -d "refs/heads/\${4#*/git/refs/heads/}" || exit 1
  exit 0
fi`;
