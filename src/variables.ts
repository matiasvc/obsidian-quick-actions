// Pure functions over the {{name}} variable grammar: what is available at a
// step, what a step uses, renaming an output, and resolving templates.
import { OutputType, Step } from "./types";
import { outputOf, templatedFields } from "./steps";

// Must match the executor's grammar exactly.
export const VAR_RE = /\{\{(\w+)\}\}/g;

export interface InputInfo {
  name: string;
  type: OutputType;
  from: number; // step index, or -1 for a built-in
}

export const BUILTINS: readonly InputInfo[] = [
  { name: "date", type: "text", from: -1 },
  { name: "time", type: "text", from: -1 },
  { name: "timestamp", type: "text", from: -1 },
];

export function isBuiltin(name: string): boolean {
  return BUILTINS.some((b) => b.name === name);
}

export function isValidName(name: string): boolean {
  return /^[A-Za-z_]\w*$/.test(name);
}

export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!set.has(candidate)) return candidate;
  }
}

export function producedNames(steps: Step[]): string[] {
  const names: string[] = [];
  for (const step of steps) {
    const out = outputOf(step);
    if (out) names.push(out.name);
  }
  return names;
}

// Built-ins plus the outputs of steps 0..i-1. When two earlier steps produce
// the same name the nearest producer wins.
export function availableInputs(steps: Step[], i: number): InputInfo[] {
  const byName = new Map<string, InputInfo>();
  for (const b of BUILTINS) byName.set(b.name, b);
  for (let j = 0; j < Math.min(i, steps.length); j++) {
    const out = outputOf(steps[j]);
    if (out) byName.set(out.name, { name: out.name, type: out.type, from: j });
  }
  return [...byName.values()];
}

export function referencedNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(VAR_RE)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

export function usedInputs(step: Step): string[] {
  const names: string[] = [];
  for (const f of templatedFields(step)) {
    for (const n of referencedNames(f.value)) {
      if (!names.includes(n)) names.push(n);
    }
  }
  return names;
}

// Indices of later steps that read the producer's output. Stops at a step
// that re-defines the same name, since consumers past it see that one.
export function consumersOf(steps: Step[], producer: number): number[] {
  const out = outputOf(steps[producer]);
  if (!out) return [];
  const result: number[] = [];
  for (let j = producer + 1; j < steps.length; j++) {
    if (usedInputs(steps[j]).includes(out.name)) result.push(j);
    const later = outputOf(steps[j]);
    if (later && later.name === out.name) break;
  }
  return result;
}

// Renames a producer's output in place and rewrites every consumer. Returns
// false, changing nothing, when the name is invalid, built-in, or produced by
// another step.
export function renameOutput(steps: Step[], producer: number, to: string): boolean {
  const step = steps[producer];
  const out = outputOf(step);
  if (!out || !("variable" in step)) return false;
  if (to === out.name) return true;
  if (!isValidName(to) || isBuiltin(to)) return false;
  for (let j = 0; j < steps.length; j++) {
    const other = outputOf(steps[j]);
    if (j !== producer && other && other.name === to) return false;
  }
  const consumers = consumersOf(steps, producer);
  const from = out.name;
  const re = new RegExp(`\\{\\{${from}\\}\\}`, "g");
  for (const j of consumers) {
    const target = steps[j] as unknown as Record<string, unknown>;
    for (const f of templatedFields(steps[j])) {
      target[f.key] = f.value.replace(re, `{{${to}}}`);
    }
  }
  step.variable = to;
  return true;
}

// Unknown names are left verbatim so a typo is visible in the result.
export function resolveTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(VAR_RE, (match, name: string) => (name in vars ? vars[name] : match));
}

// Same substitution as resolveTemplate, split into segments so a renderer can
// mark each substituted value. Unknown names come back as plain text.
export function resolveSegments(template: string, vars: Record<string, string>): { text: string; name?: string }[] {
  const segments: { text: string; name?: string }[] = [];
  let last = 0;
  for (const m of template.matchAll(VAR_RE)) {
    const start = m.index ?? 0;
    const name = m[1];
    if (!(name in vars)) continue;
    if (start > last) segments.push({ text: template.slice(last, start) });
    segments.push({ text: vars[name], name });
    last = start + m[0].length;
  }
  if (last < template.length) segments.push({ text: template.slice(last) });
  return segments;
}

export function resolveStep(step: Step, vars: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const f of templatedFields(step)) resolved[f.key] = resolveTemplate(f.value, vars);
  return resolved;
}
