import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { findQuickTasks } from "../src/quicktasks";

const appWith = (plugins: Record<string, unknown>) => ({ plugins: { plugins } }) as unknown as App;
const validApi = {
  version: 3,
  folder: "Tasks",
  askTask: () => Promise.resolve(null),
  createTask: () => Promise.resolve("Tasks/T-1.md"),
  summary: () => "“Pay rent”",
};

test("findQuickTasks reports a missing or disabled plugin", () => {
  assert.deepEqual(findQuickTasks({} as App), { error: "Quick Tasks plugin is not enabled" });
  assert.deepEqual(findQuickTasks(appWith({})), { error: "Quick Tasks plugin is not enabled" });
  assert.deepEqual(findQuickTasks(appWith({ "quick-tasks": {} })), { error: "Quick Tasks plugin is not enabled" });
});

test("findQuickTasks rejects another API version", () => {
  const found = findQuickTasks(appWith({ "quick-tasks": { api: { ...validApi, version: 1 } } }));
  assert.deepEqual(found, { error: "Quick Tasks has API version 1, but this plugin expects 3" });
});

test("findQuickTasks returns a matching API", () => {
  const found = findQuickTasks(appWith({ "quick-tasks": { api: validApi } }));
  assert.ok("api" in found && found.api.folder === "Tasks");
});
