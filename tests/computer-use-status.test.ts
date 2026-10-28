import { describe, test, expect } from "bun:test";
import { buildComputerSteps, humanizeComputerError } from "../core/computer-use-setup";

describe("电脑操控状态文案", () => {
  test("错误说人话", () => {
    expect(humanizeComputerError("spawn uvx ENOENT")).toContain("运行时");
    expect(humanizeComputerError("accessibility denied")).toContain("辅助功能");
    expect(humanizeComputerError("Screen Recording")).toContain("屏幕录制");
  });

  test("分步清单", () => {
    const steps = buildComputerSteps({
      enabled: true,
      runtimeReady: true,
      tools: 18,
      permissions: { accessibility: false, screen: true },
    });
    expect(steps.find((s) => s.id === "connect")?.ok).toBe(true);
    expect(steps.find((s) => s.id === "accessibility")?.ok).toBe(false);
    expect(steps.find((s) => s.id === "screen")?.ok).toBe(true);
  });
});
