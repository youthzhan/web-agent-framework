import type { ToolExecutionMode } from "../tools/types.js";

type ScheduledItem = { mode: ToolExecutionMode };

/**
 * Preserves the planner's order while still allowing a contiguous group of
 * independent items to run concurrently. A serial item is an explicit barrier
 * before and after itself, so it can safely depend on earlier results.
 */
export async function runByPlannedMode<T extends ScheduledItem, TResult>(
  items: readonly T[],
  execute: (item: T) => Promise<TResult>
): Promise<TResult[]> {
  const results: TResult[] = [];
  let parallelBatch: T[] = [];

  const flushParallelBatch = async (): Promise<void> => {
    if (parallelBatch.length === 0) {
      return;
    }
    results.push(...(await Promise.all(parallelBatch.map(execute))));
    parallelBatch = [];
  };

  for (const item of items) {
    if (item.mode === "parallel") {
      parallelBatch.push(item);
      continue;
    }
    await flushParallelBatch();
    results.push(await execute(item));
  }
  await flushParallelBatch();
  return results;
}
