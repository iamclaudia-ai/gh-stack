// Fixture for git-env-isolation.test.ts, run in a nested `bun test` with
// GH_STACK_* variables set, the way a push made by `GH_STACK_YES=1 gh-stack
// submit` hands them to the pre-push hook. Not matched by normal test
// discovery (no .test. in the name).
import { expect, test } from "bun:test";

// The only GH_STACK_* variables left are the preload's own test overrides
// (zero-wait #108, lsof limit #129), with the preload's values, not the caller's.
test("fixture: no GH_STACK_* variable reaches the tests", () => {
  const vars = Object.entries(process.env).filter(([name]) => name.startsWith("GH_STACK_"));
  expect(Object.fromEntries(vars)).toEqual({
    GH_STACK_TEST_RETRY_DELAY_MS: "0",
    GH_STACK_TEST_HELPER_TIMEOUT_MS: "20000",
  });
});
