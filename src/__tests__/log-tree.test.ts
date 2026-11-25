// #156: `log` draws sibling branches (several on one parent) as a tree, the way
// the PR descriptions' tree does since #144. A straight stack renders exactly
// as before; numbering stays depth-first, as `checkout <N>` counts it.
import { describe, expect, test } from "bun:test";
import type { Stack } from "../types.ts";
import { renderStackTree } from "../lib/ui.ts";

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function stackOf(parents: Record<string, string>, base?: string): Stack {
  const branches: Stack["branches"] = {};
  let n = 0;
  for (const [name, parent] of Object.entries(parents)) {
    n++;
    branches[name] = { parent, pr: n, description: `PR ${n}` };
  }
  return { description: "", last_branch: null, branches, ...(base ? { base } : {}) };
}

function draw(stack: Stack, current = "", showNumbers = true): string {
  return stripAnsi(renderStackTree(stack, current, { showNumbers }));
}

describe("log's stack tree (#156)", () => {
  test("a straight stack renders exactly as before", () => {
    const stack = stackOf({ pr1: "main", pr2: "pr1", pr3: "pr2" });
    expect(draw(stack, "pr2")).toBe(
      [
        "◯ main",
        "┃",
        "┣━◯ [1] pr1",
        "┃   #1: PR 1",
        "┃",
        "┣━◯ [2] pr2 (current)",
        "┃   #2: PR 2",
        "┃",
        "┗━◯ [3] pr3",
        "┃   #3: PR 3",
      ].join("\n"),
    );
  });

  test("siblings hang under their parent (the dependency sweep's shape)", () => {
    const stack = stackOf({ batch: "main", expo: "batch", oxfmt: "batch" });
    expect(draw(stack)).toBe(
      [
        "◯ main",
        "┃",
        "┗━◯ [1] batch",
        "  ┃ #1: PR 1",
        "  ┃",
        "  ┣━◯ [2] expo",
        "  ┃   #2: PR 2",
        "  ┃",
        "  ┗━◯ [3] oxfmt",
        "      #3: PR 3",
      ].join("\n"),
    );
  });

  test("a straight run, then siblings, then a chain on one of them", () => {
    const stack = stackOf({ a: "main", b: "a", c: "b", d: "c", e: "b" });
    expect(draw(stack)).toBe(
      [
        "◯ main",
        "┃",
        "┣━◯ [1] a",
        "┃   #1: PR 1",
        "┃",
        "┗━◯ [2] b",
        "  ┃ #2: PR 2",
        "  ┃",
        "  ┣━◯ [3] c",
        "  ┃ ┃ #3: PR 3",
        "  ┃ ┃",
        "  ┃ ┗━◯ [4] d",
        "  ┃     #4: PR 4",
        "  ┃",
        "  ┗━◯ [5] e",
        "      #5: PR 5",
      ].join("\n"),
    );
  });

  test("the last sibling's chain has no guide for siblings after it", () => {
    const stack = stackOf({ a: "main", b: "a", c: "a", d: "c" });
    expect(draw(stack)).toBe(
      [
        "◯ main",
        "┃",
        "┗━◯ [1] a",
        "  ┃ #1: PR 1",
        "  ┃",
        "  ┣━◯ [2] b",
        "  ┃   #2: PR 2",
        "  ┃",
        "  ┗━◯ [3] c",
        "    ┃ #3: PR 3",
        "    ┃",
        "    ┗━◯ [4] d",
        "        #4: PR 4",
      ].join("\n"),
    );
  });

  test("several branches on the base start the tree there", () => {
    const stack = stackOf({ a: "main", b: "main", c: "b" });
    expect(draw(stack)).toBe(
      [
        "◯ main",
        "┃",
        "┣━◯ [1] a",
        "┃   #1: PR 1",
        "┃",
        "┗━◯ [2] b",
        "  ┃ #2: PR 2",
        "  ┃",
        "  ┗━◯ [3] c",
        "      #3: PR 3",
      ].join("\n"),
    );
  });

  test("numbers follow depth-first order, the order checkout <N> counts", () => {
    // Insertion order puts the second sibling before the first one's child.
    const stack = stackOf({ a: "main", b: "a", c: "a", d: "b" });
    const lines = draw(stack).split("\n");
    const at = (name: string) => lines.findIndex((l) => l.endsWith(`] ${name}`));
    expect(lines[at("a")]).toContain("[1] a");
    expect(lines[at("b")]).toContain("[2] b");
    expect(lines[at("d")]).toContain("[3] d");
    expect(lines[at("c")]).toContain("[4] c");
    expect(at("b")).toBeLessThan(at("d"));
    expect(at("d")).toBeLessThan(at("c"));
  });

  test("the current branch and no numbers work in the tree too", () => {
    const stack = stackOf({ batch: "main", expo: "batch", oxfmt: "batch" });
    expect(draw(stack, "expo", false)).toBe(
      [
        "◯ main",
        "┃",
        "┗━◯ batch",
        "  ┃ #1: PR 1",
        "  ┃",
        "  ┣━◯ expo (current)",
        "  ┃   #2: PR 2",
        "  ┃",
        "  ┗━◯ oxfmt",
        "      #3: PR 3",
      ].join("\n"),
    );
  });

  test("a split stack's base is labelled as before", () => {
    const stack = stackOf({ x: "feature", y: "x", z: "x" }, "feature");
    expect(draw(stack).split("\n")[0]).toBe("◯ feature (base — in parent stack)");
  });
});
