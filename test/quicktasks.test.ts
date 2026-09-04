import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { findQuickTasks, taskSummary } from "../src/quicktasks";

const appWith = (plugins: Record<string, unknown>) => ({ plugins: { plugins } }) as unknown as App;
const validApi = { version: 1, folder: "Tasks", askTask: () => Promise.resolve(null), createTask: () => Promise.resolve("Tasks/T-1.md") };

test("findQuickTasks reports a missing or disabled plugin", () => {
  assert.deepEqual(findQuickTasks({} as App), { error: "Quick Tasks plugin is not enabled" });
  assert.deepEqual(findQuickTasks(appWith({})), { error: "Quick Tasks plugin is not enabled" });
  assert.deepEqual(findQuickTasks(appWith({ "quick-tasks": {} })), { error: "Quick Tasks plugin is not enabled" });
});

test("findQuickTasks rejects another API version", () => {
  const found = findQuickTasks(appWith({ "quick-tasks": { api: { ...validApi, version: 2 } } }));
  assert.deepEqual(found, { error: "Quick Tasks API version 2, this plugin expects 1" });
});

test("findQuickTasks returns a matching API", () => {
  const found = findQuickTasks(appWith({ "quick-tasks": { api: validApi } }));
  assert.ok("api" in found && found.api.folder === "Tasks");
});

test("taskSummary", () => {
  assert.equal(taskSummary({ title: "Pay rent", due: null, priority: "none", tags: [], project: null, repeat: null }), "“Pay rent”");
  assert.equal(
    taskSummary({ title: "Pay rent", due: "2026-09-05", priority: "high", tags: ["home", "money"], project: "Garden", repeat: { text: "every week" } }),
    "“Pay rent” · due 2026-09-05 · high · #home · #money · @Garden · every week",
  );
});
