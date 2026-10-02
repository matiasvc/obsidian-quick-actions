// The If blocks of a step list. A block lies flat in the list as an if, any else_ifs, an optional
// else and an end_if, so every step keeps a plain index and the structure is derived here.
// No obsidian import, so the node tests cover it.
import { Step, TestOp } from "./types";

// A block's markers after its if. They only shape the block and get no step number.
export function isMarker(step: Step): boolean {
  return step.type === "else_if" || step.type === "else" || step.type === "end_if";
}

export interface Block {
  start: number; // the if
  branches: number[]; // the if, then each else_if, then the else
  end: number; // the end_if
}

// Every block, by the index of its if. Expects a list repairBlocks has made whole.
export function blocksOf(steps: Step[]): Map<number, Block> {
  const blocks = new Map<number, Block>();
  const open: Block[] = [];
  steps.forEach((s, i) => {
    if (s.type === "if") open.push({ start: i, branches: [i], end: -1 });
    else if ((s.type === "else_if" || s.type === "else") && open.length) open[open.length - 1].branches.push(i);
    else if (s.type === "end_if" && open.length) {
      const block = open.pop() as Block;
      block.end = i;
      blocks.set(block.start, block);
    }
  });
  return blocks;
}

// The block whose if, else_if, else or end_if sits at `marker`.
export function blockOfMarker(steps: Step[], marker: number, blocks = blocksOf(steps)): Block | undefined {
  for (const b of blocks.values()) if (b.branches.includes(marker) || b.end === marker) return b;
  return undefined;
}

// The last index of the step at i: its end_if when it is an if, so an If moves, copies and
// deletes with its whole block.
export function spanEnd(steps: Step[], i: number): number {
  return steps[i].type === "if" ? (blocksOf(steps).get(i)?.end ?? i) : i;
}

// The index just past branch k of a block: the next branch's marker, or the end_if.
export function branchEnd(block: Block, k: number): number {
  return block.branches[k + 1] ?? block.end;
}

// Which branch of a block index i sits in.
export function branchOf(block: Block, i: number): number {
  return block.branches.filter((m) => m <= i).length - 1;
}

// The innermost block that holds both indices strictly between its if and its end_if.
function innermost(steps: Step[], lo: number, hi: number): Block | null {
  let best: Block | null = null;
  for (const b of blocksOf(steps).values()) {
    if (b.start < lo && hi < b.end && (!best || b.start > best.start)) best = b;
  }
  return best;
}

// The innermost block a step sits inside, and which of its branches it is in. A block's own
// else_ifs and else count as inside it. Its if and end_if sit at the level around it.
export function placeOf(steps: Step[], i: number): { block: Block; branch: number } | null {
  const block = innermost(steps, i, i);
  return block ? { block, branch: branchOf(block, i) } : null;
}

// Whether two steps can never both run, because they sit in different branches of one block.
export function exclusive(steps: Step[], a: number, b: number): boolean {
  const block = innermost(steps, Math.min(a, b), Math.max(a, b));
  return block !== null && branchOf(block, a) !== branchOf(block, b);
}

// Where a run goes on from index i. Reaching an else_if or else means the branch that ran is
// done, so the run leaves the block. An end_if is stepped over.
export function skipMarkers(steps: Step[], i: number, blocks = blocksOf(steps)): number {
  while (i < steps.length && isMarker(steps[i])) {
    i = steps[i].type === "end_if" ? i + 1 : (blockOfMarker(steps, i, blocks)?.end ?? i) + 1;
  }
  return i;
}

// A copy of the list with stray markers dropped and unclosed blocks closed, so a hand-edited
// data.json can't leave a branch without its block.
export function repairBlocks(steps: Step[]): Step[] {
  const out: Step[] = [];
  const open: { hasElse: boolean }[] = [];
  for (const s of steps) {
    if (s.type === "if") open.push({ hasElse: false });
    else if (s.type === "else_if" || s.type === "else") {
      const top = open[open.length - 1];
      if (!top || top.hasElse) continue;
      if (s.type === "else") top.hasElse = true;
    } else if (s.type === "end_if") {
      if (!open.length) continue;
      open.pop();
    }
    out.push(s);
  }
  for (let k = 0; k < open.length; k++) out.push({ type: "end_if" });
  return out;
}

// Each step's number in the list, counting the if of a block but not its other markers, which
// get 0.
export function stepNumbers(steps: Step[]): number[] {
  let n = 0;
  return steps.map((s) => (isMarker(s) ? 0 : ++n));
}

// How many numbered steps there are.
export function stepCount(steps: Step[]): number {
  return steps.filter((s) => !isMarker(s)).length;
}

export const TEST_OPS: { value: TestOp; label: string; needsText: boolean }[] = [
  { value: "filled", label: "has text", needsText: false },
  { value: "empty", label: "is empty", needsText: false },
  { value: "is", label: "is", needsText: true },
  { value: "is_not", label: "is not", needsText: true },
  { value: "contains", label: "contains", needsText: true },
  { value: "not_contains", label: "does not contain", needsText: true },
  { value: "matches", label: "matches pattern", needsText: true },
];

// Whether a resolved value passes a test. Comparisons ignore case and the spaces around values.
// A pattern is a regular expression. A bad one throws.
export function testPasses(op: TestOp, value: string, text: string): boolean {
  const v = value.trim().toLowerCase();
  const t = text.trim().toLowerCase();
  switch (op) {
    case "filled":
      return v !== "";
    case "empty":
      return v === "";
    case "is":
      return v === t;
    case "is_not":
      return v !== t;
    case "contains":
      return v.includes(t);
    case "not_contains":
      return !v.includes(t);
    case "matches":
      return new RegExp(text.trim(), "i").test(value.trim());
  }
}

// Moves the step at `from`, with its whole block when it is an if, to where a single-item reorder
// would put it at `to`. Returns where it now starts, or -1 when a block would land inside itself.
export function moveSteps(steps: Step[], from: number, to: number): number {
  const len = spanEnd(steps, from) - from + 1;
  const at = to >= from ? to + 1 : to; // the insertion point, counted before the move
  if (len > 1 && at > from && at < from + len) return -1;
  const items = steps.splice(from, len);
  const start = at > from ? at - len : at;
  steps.splice(start, 0, ...items);
  return start;
}

// The `to` that moves the step at `from` so it goes in just before index `before`.
export function moveTo(from: number, before: number): number {
  return before > from ? before - 1 : before;
}

// Removes an else_if or else, moving the steps of its branch to just after the block. Returns the
// moved steps.
export function removeBranch(steps: Step[], marker: number): Step[] {
  const block = blockOfMarker(steps, marker);
  if (!block || marker === block.start || marker === block.end) return [];
  const moved = steps.splice(marker + 1, branchEnd(block, block.branches.indexOf(marker)) - marker - 1);
  steps.splice(block.end - moved.length + 1, 0, ...moved);
  steps.splice(marker, 1);
  return moved;
}

// Removes a block's markers and keeps its steps where they are.
export function unwrapBlock(steps: Step[], start: number): void {
  const block = blocksOf(steps).get(start);
  if (!block) return;
  for (const i of [block.end, ...block.branches].sort((a, b) => b - a)) steps.splice(i, 1);
}
