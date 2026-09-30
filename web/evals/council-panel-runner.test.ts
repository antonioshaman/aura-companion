/**
 * `diffSize` sizes the ECONOMY seat budget, so a miscount changes the panel.
 * Binary files (`-\t-`) count as a changed file with zero lines.
 */
import { describe, expect, it } from "vitest";

import { diffSize } from "./council-panel-runner.js";

describe("diffSize", () => {
  it("sums added + deleted lines over text files and counts binary files as files", () => {
    expect(diffSize("10\t2\tweb/a.ts\n-\t-\tweb/img.png\n0\t5\tweb/b.ts\n")).toEqual({ diffFiles: 3, diffLines: 17 });
  });
  it("ignores blank and malformed lines", () => {
    expect(diffSize("\nnot numstat\n")).toEqual({ diffFiles: 0, diffLines: 0 });
  });
});
