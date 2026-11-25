// TUI helpers: tree rendering, formatting, prompts
import * as p from "./output.ts";
import * as git from "./git.ts";
import pc from "picocolors";
import type { Stack, StackMetadata } from "../types.ts";
import { getOrderedBranches, stackBase } from "./metadata.ts";

// ── Auto-yes mode (for agents/CI) ──

let _autoYes = false;

/**
 * Enable/disable auto-yes mode (skip all confirmations).
 * Set via --yes flag or GH_STACK_YES=1 env var.
 */
export function setAutoYes(enabled: boolean): void {
  _autoYes = enabled;
}

export function isAutoYes(): boolean {
  return _autoYes;
}

/**
 * Render a stack as a tree with branch numbers, PR info, and current marker.
 *
 * A straight run from a sole root is the one column a linear stack has always
 * rendered as. The first branch with several children ends the run, and its
 * children hang under its ◯ as an indented tree, as the PR descriptions' tree
 * does (#144, #156). Several roots on the base start the tree straight away.
 * Numbers are depth-first, the order `checkout <N>` counts.
 */
export function renderStackTree(
  stack: Stack,
  currentBranch: string,
  options?: { showNumbers?: boolean },
): string {
  const ordered = getOrderedBranches(stack);
  const showNumbers = options?.showNumbers ?? true;
  const lines: string[] = [];

  const base = stackBase(stack);
  const baseIsTrunk = git.isTrunkName(base);
  const baseHint = baseIsTrunk ? "" : pc.dim(" (base — in parent stack)");
  lines.push(`${pc.green("◯")} ${base}${baseHint}`);

  const number = new Map(ordered.map((name, i) => [name, i + 1]));
  const children = (parent: string) =>
    ordered.filter((name) => stack.branches[name]!.parent === parent);

  /** One branch: a separator, its line after `connector`, its PR line after `guide`. */
  const entry = (branchName: string, separator: string, connector: string, guide: string) => {
    const branch = stack.branches[branchName]!;
    const isCurrent = branchName === currentBranch;
    const numLabel = showNumbers ? `[${pc.blue(String(number.get(branchName)))}] ` : "";
    const marker = isCurrent ? ` ${pc.yellow("(current)")}` : "";
    const prNum = branch.pr ? `#${branch.pr}` : "(no PR)";
    const desc = branch.description || branchName;

    lines.push(separator);
    if (isCurrent) {
      lines.push(`${connector} ${numLabel}${pc.yellow(branchName)}${marker}`);
      lines.push(`${guide}${pc.blue(prNum)}: ${desc}`);
    } else {
      lines.push(`${connector} ${numLabel}${branchName}`);
      lines.push(`${guide}${pc.dim(`${prNum}: ${desc}`)}`);
    }
  };

  /** `nodes` as siblings under the ◯ above `prefix`, each with its subtree. */
  const tree = (nodes: string[], prefix: string) => {
    nodes.forEach((name, k) => {
      const last = k === nodes.length - 1;
      const kids = children(name);
      const guide = `${prefix}${last ? " " : "┃"} ${kids.length > 0 ? "┃" : " "} `;
      entry(name, `${prefix}┃`, `${prefix}${last ? "┗━◯" : "┣━◯"}`, guide);
      tree(kids, prefix + (last ? "  " : "┃ "));
    });
  };

  const roots = children(base);
  if (roots.length !== 1) {
    tree(roots, "");
    return lines.join("\n");
  }
  let node = roots[0]!;
  while (children(node).length === 1) {
    entry(node, "┃", "┣━◯", "┃   ");
    node = children(node)[0]!;
  }
  if (children(node).length === 0) entry(node, "┃", "┗━◯", "┃   ");
  else tree([node], "");

  return lines.join("\n");
}

/**
 * Display a header banner.
 */
export function header(title: string): void {
  p.intro(pc.cyan(title));
}

/**
 * Display a footer banner.
 */
export function footer(title: string): void {
  p.outro(pc.green(title));
}

/**
 * Stop with exit 1 where a picker would ask under --yes: --yes can't choose,
 * and a "Cancelled" exit 0 reads as success to an agent (#159). `instead`
 * says what to pass.
 */
function refuseToPick(message: string, instead: string): never {
  p.cancel(`${message}: --yes can't choose for you. ${instead}`);
  process.exit(1);
}

/**
 * Interactive branch selector for a stack.
 * Returns the selected branch name, or null if cancelled. Under --yes it exits
 * 1, telling the caller to name the branch (`instead`, or a generic hint).
 */
export async function selectBranch(
  stack: Stack,
  message: string,
  currentBranch?: string,
  instead = "Name the branch as an argument.",
): Promise<string | null> {
  const ordered = getOrderedBranches(stack);

  if (ordered.length === 0) {
    p.log.warn("No branches in this stack");
    return null;
  }

  if (_autoYes) refuseToPick(message, instead);

  const options = ordered.map((name) => {
    const branch = stack.branches[name]!;
    const prNum = branch.pr ? `#${branch.pr}` : "";
    const desc = branch.description || "";
    const current = name === currentBranch ? pc.yellow(" (current)") : "";
    const label = `${name}${current}`;
    const hint = [prNum, desc].filter(Boolean).join(" — ");

    return { value: name, label, hint };
  });

  const result = await p.select({ message, options }, instead);

  if (p.isCancel(result)) return null;
  return result as string;
}

/**
 * Interactive stack selector.
 * Returns the selected stack name, or null if cancelled.
 */
export async function selectStack(meta: StackMetadata, message: string): Promise<string | null> {
  const stackNames = Object.keys(meta.stacks);

  if (stackNames.length === 0) {
    p.log.warn("No stacks found");
    return null;
  }

  const instead = `Switch to a branch of the stack instead: ${pc.green("gh-stack checkout <branch>")}.`;
  if (_autoYes) refuseToPick(message, instead);

  const options = stackNames.map((name) => {
    const stack = meta.stacks[name]!;
    const branchCount = Object.keys(stack.branches).length;
    const current = name === meta.current_stack ? pc.yellow(" (current)") : "";
    const label = `${name}${current}`;
    const hint = `${branchCount} branch${branchCount !== 1 ? "es" : ""}${stack.description ? ` — ${stack.description}` : ""}`;

    return { value: name, label, hint };
  });

  const result = await p.select({ message, options }, instead);

  if (p.isCancel(result)) return null;
  return result as string;
}

/**
 * Pick one of several branches `up`/`top` could go to (#158). --yes can't
 * choose, so under --yes (or with nobody to answer) it stops with exit 1,
 * naming them and the command that goes straight to one.
 */
export async function chooseBranch(
  stack: Stack,
  message: string,
  branches: string[],
  what: string,
): Promise<string> {
  const instead = `${what}: ${branches.join(", ")}. Go to one with ${pc.green("gh-stack checkout <branch>")}.`;
  if (_autoYes) refuseToPick(message, instead);
  const result = await p.select(
    {
      message,
      options: branches.map((b) => ({
        value: b,
        label: b,
        hint: stack.branches[b]?.pr ? `#${stack.branches[b]!.pr}` : undefined,
      })),
    },
    `--yes can't choose a branch. ${instead}`,
  );
  if (p.isCancel(result)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  return result as string;
}

/**
 * Confirm a destructive action.
 * In auto-yes mode, returns true immediately without prompting.
 */
export async function confirmAction(message: string): Promise<boolean> {
  if (_autoYes) {
    p.log.info(`${message} ${pc.dim("(auto-yes)")}`);
    return true;
  }

  const result = await p.confirm({ message });
  if (p.isCancel(result)) return false;
  return result;
}

/**
 * Format a branch for inline display.
 */
export function branchLabel(name: string): string {
  return pc.yellow(name);
}

/**
 * Format a PR number for inline display.
 */
export function prLabel(num: number): string {
  return pc.blue(`#${num}`);
}
