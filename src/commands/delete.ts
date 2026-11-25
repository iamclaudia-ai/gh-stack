// gh-stack delete — Delete a branch from the stack (re-link parent chain).
// gh-stack untrack — the same removal, metadata only (untrack.ts).
import * as p from "../lib/output.ts";
import pc from "picocolors";
import {
  archiveStack,
  findStackForBranch,
  getChildren,
  removeBranchFromStack,
  stackBase,
  writeMetadata,
} from "../lib/metadata.ts";
import type { StackMetadata } from "../types.ts";
import {
  ensureMetadata,
  ensureCurrentStack,
  ensureValidStack,
  resolveStackForBranchArg,
} from "../lib/safety.ts";
import { takeSnapshot } from "../lib/snapshot.ts";
import { selectBranch, confirmAction } from "../lib/ui.ts";
import * as git from "../lib/git.ts";
import { checksBeforeRetargetNote, deleteBranchOnGitHub, setPrBase } from "../lib/github.ts";
import { keptWhileTargeted } from "../lib/advance.ts";

const UNTRACK_HELP = `
gh-stack untrack — Stop tracking a branch; the branch and its PR stay

USAGE
  gh-stack untrack [<branch>]

Removes the branch from its stack's metadata and nothing else: the local
branch, its copy on origin and its PR are left exactly as they are. Children
are re-parented to the untracked branch's parent, the same as delete.

The branch keeps its PR number, so gh-stack add <branch> puts it back with
its PR. Untracking a stack's last branch archives the empty stack.

If no branch is specified, shows an interactive selector.
`;

/**
 * `delete`, or with `untrack` the metadata-only removal (same as
 * `delete --keep-branch`, minus the confirmation: nothing leaves git).
 */
export default async function deleteCmd(
  args: string[],
  opts: { untrack?: boolean } = {},
): Promise<void> {
  const untrack = opts.untrack === true;
  if (untrack && args.includes("--help")) {
    console.log(UNTRACK_HELP);
    return;
  }
  if (args.includes("--help")) {
    console.log(`
gh-stack delete — Delete a branch from the stack

USAGE
  gh-stack delete [<branch>] [options]

Removes the branch from the stack and deletes the underlying git branch,
re-parenting any children to the removed branch's parent. If the deleted
branch was pushed, its copy on GitHub is deleted too, through the API, so the
repo's pre-push hook doesn't run.

Before that, the children's PRs move onto the new parent: GitHub closes a PR
whose base branch is deleted. If an open PR still targets the branch, its copy
on GitHub is kept and the PR named. The children aren't rebased, so they (and
their PRs) keep the deleted branch's commits. If GitHub already deleted the
branch, the leftover origin/<branch> tracking ref goes instead.

Deleting a stack's root that has several children leaves them side by side on
the base, so each child (with the branches above it) becomes its own stack.
Deleting a stack's last branch archives the empty stack
(gh-stack archive --restore <name> brings it back).

If no branch is specified, shows an interactive selector.

To take a branch out of the stack without deleting anything, use
gh-stack untrack <branch>: the branch and its PR stay.

OPTIONS
  -k, --keep-branch   Only remove from the stack metadata, the same as
                      gh-stack untrack
      --no-remote     Delete the local branch but keep the remote branch
`);
    return;
  }

  const keepBranch = untrack || args.includes("--keep-branch") || args.includes("-k");
  const noRemote = args.includes("--no-remote");
  const positional = args.filter((a) => !a.startsWith("-"));

  const meta = await ensureMetadata();
  // The branch to delete names its own stack — resolve from it so
  // `delete <branch>` works from anywhere. Only fall back to the current stack
  // (the branch you're on) in interactive mode, when no branch was given.
  const stackName = positional[0]
    ? resolveStackForBranchArg(meta, positional[0]!)
    : ensureCurrentStack(meta);
  // The branch being deleted may be gone locally already: removing it is the fix.
  await ensureValidStack(meta, stackName, { allowMissing: positional[0] ? [positional[0]] : [] });
  const stack = meta.stacks[stackName]!;
  // Detached HEAD is fine: `delete <branch>` doesn't need a current branch.
  const currentBranch = (await git.currentBranch().catch(() => null)) ?? undefined;

  p.intro(pc.cyan(untrack ? "Untrack Branch" : "Delete Branch from Stack"));

  // Get branch to delete
  let branchName = positional[0];
  if (!branchName) {
    branchName =
      (await selectBranch(
        stack,
        untrack ? "Select branch to untrack" : "Select branch to delete",
        currentBranch,
      )) ?? undefined;
    if (!branchName) {
      p.cancel("Cancelled");
      process.exit(0);
    }
  }

  // Validate
  const branch = stack.branches[branchName];
  if (!branch) {
    p.cancel(`Branch ${pc.yellow(branchName)} not found in stack ${pc.blue(stackName)}`);
    process.exit(1);
  }

  // Discover what actually exists in git so we report (and delete) accurately
  const hasLocal = !keepBranch && (await git.localBranchExists(branchName));
  const remote = keepBranch || noRemote ? null : await git.remoteBranchState(branchName);
  const hasRemote = remote === "present";
  const trackingRef = `refs/remotes/origin/${branchName}`;
  // Origin may have lost the branch already (deleted on GitHub) while the
  // tracking ref lingers until the next fetch --prune (#114). Only a definite
  // "absent" counts: an unreachable origin may still have it.
  const staleTracking = remote === "absent" && (await git.refExists(trackingRef));

  // Show what will happen
  const children = getChildren(stack, branchName);
  // Read before removeBranchFromStack, which can move children to new stacks.
  const childPrs = children.flatMap((child) => {
    const pr = stack.branches[child]?.pr;
    return pr == null ? [] : [{ child, pr }];
  });
  p.log.info(`Removing: ${pc.yellow(branchName)} from stack ${pc.blue(stackName)}`);
  p.log.info(`Parent was: ${pc.dim(branch.parent)}`);

  if (children.length > 0) {
    p.log.info(
      `Re-parenting ${children.length} child branch${children.length > 1 ? "es" : ""} to ${pc.dim(branch.parent)}`,
    );
    for (const child of children) {
      console.log(`    ${pc.dim("→")} ${child}`);
    }
    if (children.length > 1 && branch.parent === stackBase(stack)) {
      p.log.info(
        pc.dim(
          `They'll sit side by side on ${branch.parent}, so each becomes its own stack (${children[0]} keeps ${stackName}).`,
        ),
      );
    }
  }

  if (untrack) {
    p.log.info(pc.dim("Stack metadata only: the git branch, origin's copy and the PR stay"));
  } else if (keepBranch) {
    p.log.info(pc.dim("Keeping git branch (--keep-branch) — stack metadata only"));
  } else {
    if (hasLocal) p.log.info(`Deleting local branch ${pc.yellow(branchName)}`);
    if (hasRemote) {
      for (const { child, pr } of childPrs) {
        p.log.info(`Moving PR #${pr} (${child}) onto ${pc.dim(branch.parent)} first`);
      }
      p.log.info(`Deleting remote branch ${pc.yellow(`origin/${branchName}`)}`);
    }
    if (remote === "unknown") {
      p.log.warn(
        `Couldn't reach origin, so ${pc.yellow(`origin/${branchName}`)} is left as it is: it may still be on GitHub, with PRs on it`,
      );
    }
    if (staleTracking) {
      p.log.info(
        `Dropping ${pc.yellow(`origin/${branchName}`)}: GitHub no longer has it, only the local tracking ref is left`,
      );
    }
    if (!hasLocal && !hasRemote && !staleTracking && remote !== "unknown") {
      p.log.info(pc.dim("No git branch found to delete — stack metadata only"));
    }
  }

  // Confirm (respects --yes / GH_STACK_YES — no interactive hang for agents).
  // Untrack doesn't ask: nothing leaves git, and `add` undoes it.
  const confirmed = untrack || (await confirmAction(`Delete ${pc.yellow(branchName)}?`));
  if (!confirmed) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  // Take snapshot before destructive operation
  await takeSnapshot(meta, stackName, untrack ? "untrack" : "delete");

  // If we're sitting on the branch we're about to delete, git won't let us
  // remove it — move to the parent (or trunk) first.
  if (hasLocal && branchName === currentBranch) {
    const fallback = (await git.localBranchExists(branch.parent))
      ? branch.parent
      : await git.trunkBranch();
    await git.checkout(fallback);
    p.log.info(`Switched to ${pc.blue(fallback)} (was on the deleted branch)`);
  }

  // Remove from metadata (re-parents children, fixes last_branch, splits siblings)
  const split = await removeBranchFromStack(meta, stackName, branchName);
  if (split.length > 0) {
    p.log.success(
      `Split off ${split.map((s) => pc.yellow(s)).join(", ")} beside ${pc.blue(stackName)}`,
    );
  }

  // The last branch left: archive the empty stack rather than leave a shell in
  // `stacks` that nothing else would clean up (#68).
  if (Object.keys(meta.stacks[stackName]?.branches ?? {}).length === 0) {
    const archivedAs = archiveStack(meta, stackName);
    await writeMetadata(meta);
    p.log.success(
      `Stack ${pc.blue(stackName)} is empty now, so it was archived` +
        pc.dim(`  (restore: gh-stack archive --restore ${archivedAs})`),
    );
  }

  // Delete the actual git branch(es)
  if (hasRemote) await deleteRemoteBranch(meta, branchName, branch.parent, childPrs);
  if (staleTracking) {
    await git.runGit(["update-ref", "-d", trackingRef]);
    p.log.success(`Dropped stale tracking ref ${pc.dim(`origin/${branchName}`)}`);
  }
  if (hasLocal) {
    const ok = await git.deleteLocalBranch(branchName);
    if (ok) {
      p.log.success(`Deleted local branch ${pc.dim(branchName)}`);
    } else {
      p.log.warn(`Could not delete local branch ${pc.dim(branchName)} (delete it manually)`);
    }
  }

  if (untrack) {
    p.outro(
      pc.green(`Untracked ${pc.yellow(branchName)} from stack ${pc.blue(stackName)}`) +
        pc.dim(`  (put it back: gh-stack add ${branchName})`),
    );
    return;
  }
  p.outro(pc.green(`Removed ${pc.yellow(branchName)} from stack ${pc.blue(stackName)}`));
}

/**
 * Delete origin's copy of `branchName`, after moving its children's PRs onto
 * `newParent` (#112): GitHub closes a PR whose base branch is deleted, and
 * won't reopen it once its head is pushed again. A PR that still targets the
 * branch afterwards (a failed retarget, someone else's PR) keeps it alive.
 *
 * The children aren't rebased: they keep the deleted branch's commits (restack
 * keeps them too), so their PRs now list those commits. Nothing pushes them
 * either, so a PR moved onto the trunk gets the checks note (#162): its last
 * push ran the checks against the deleted branch.
 */
async function deleteRemoteBranch(
  meta: StackMetadata,
  branchName: string,
  newParent: string,
  childPrs: { child: string; pr: number }[],
): Promise<void> {
  const moved: string[] = [];
  const notes: string[] = [];
  for (const { child, pr } of childPrs) {
    const r = await setPrBase(pr, newParent);
    if (r.ok) {
      moved.push(child);
      p.log.success(`PR #${pr} (${child}) base → ${pc.green(newParent)}`);
      const note = checksBeforeRetargetNote(pr, child, branchName, newParent);
      if (note) notes.push(note);
    } else {
      p.log.warn(`Could not retarget PR #${pr} (${child}) to ${newParent} (${r.error})`);
    }
  }
  if (moved.length > 0) {
    // Record the base, as merge and join do, so restack and submit don't
    // repeat the edit. A failed retarget keeps the old prBase: they retry it.
    for (const child of moved) {
      const name = findStackForBranch(meta, child);
      const entry = name ? meta.stacks[name]?.branches[child] : undefined;
      if (entry) entry.prBase = newParent;
    }
    await writeMetadata(meta);
    p.log.info(
      pc.dim(
        moved.length === 1
          ? `${moved[0]} is still built on ${branchName}'s commits, so its PR lists them now`
          : `${moved.join(", ")} are still built on ${branchName}'s commits, so their PRs list them now`,
      ),
    );
    for (const note of notes) p.log.warn(note);
  }

  if (await keptWhileTargeted(branchName)) return;

  // Through the API, as merge -d does (#107): a `git push --delete` would run
  // the repo's pre-push hook, which can be a full test suite.
  const deleted = await deleteBranchOnGitHub(branchName);
  if (deleted.ok) {
    // Like `git push --delete`, drop the remote-tracking ref too.
    await git.runGit(["update-ref", "-d", `refs/remotes/origin/${branchName}`]);
    p.log.success(`Deleted remote branch ${pc.dim(`origin/${branchName}`)}`);
  } else {
    p.log.warn(
      `Could not delete remote branch ${pc.dim(`origin/${branchName}`)} on GitHub (${deleted.error}). Delete it manually.`,
    );
  }
}
