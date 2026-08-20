import { describe, expect, it } from "vitest";
import { runByPlannedMode } from "../src/skills/scheduling.js";

describe("skill scheduling", () => {
  it("runs contiguous parallel groups concurrently and serial items as barriers", async () => {
    const events: string[] = [];
    const items = [
      { id: "a", mode: "serial" as const, delay: 5 },
      { id: "b", mode: "parallel" as const, delay: 15 },
      { id: "c", mode: "parallel" as const, delay: 5 },
      { id: "d", mode: "serial" as const, delay: 1 }
    ];

    const results = await runByPlannedMode(items, async (item) => {
      events.push(`start:${item.id}`);
      await new Promise((resolve) => setTimeout(resolve, item.delay));
      events.push(`end:${item.id}`);
      return item.id;
    });

    expect(results).toEqual(["a", "b", "c", "d"]);
    expect(events.indexOf("end:a")).toBeLessThan(events.indexOf("start:b"));
    expect(events.indexOf("start:b")).toBeLessThan(events.indexOf("end:c"));
    expect(events.indexOf("start:c")).toBeLessThan(events.indexOf("end:b"));
    expect(events.indexOf("end:b")).toBeLessThan(events.indexOf("start:d"));
    expect(events.indexOf("end:c")).toBeLessThan(events.indexOf("start:d"));
  });
});
