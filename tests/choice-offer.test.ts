import { describe, test, expect } from "bun:test";
import { detectChoiceOffer, extractEnumOptions } from "../core/choice-offer";

describe("extractEnumOptions", () => {
  test("抽出 1. 2. 3. 列表", () => {
    expect(extractEnumOptions("有几条路：\n1. 只看文件\n2. 打开终端\n3. 进 Coding CLI")).toEqual([
      "只看文件",
      "打开终端",
      "进 Coding CLI",
    ]);
  });

  test("抽出 A/B 与项目符号", () => {
    expect(extractEnumOptions("可选：\nA. 改挂 AutobuyA\nB. 继续 LuminaAI\n- 先不改")).toEqual([
      "改挂 AutobuyA",
      "继续 LuminaAI",
      "先不改",
    ]);
  });

  test("说明性长句不收入", () => {
    expect(extractEnumOptions("步骤：\n1. 打开仓库后先读 README，再决定怎么拆模块与提测流程\n2. 然后跑完整回归测试并出报告")).toEqual([]);
  });
});

describe("detectChoiceOffer", () => {
  test("强选择话术 → hard", () => {
    const r = detectChoiceOffer("提审文案有三种出法，你选一个：\n1. 等合进 main\n2. 按草案出\n3. 只写 Baserow");
    expect(r?.kind).toBe("hard");
    if (r?.kind === "hard") {
      expect(r.options).toEqual(["等合进 main", "按草案出", "只写 Baserow"]);
      expect(r.question.length).toBeGreaterThan(0);
    }
  });

  test("建议/方案枚举 → soft", () => {
    const r = detectChoiceOffer("建议下一步可以：\n1. 先核对 skill 边界\n2. 改挂 package lane\n3. 继续只跑工厂产包");
    expect(r).toEqual({
      kind: "soft",
      options: ["先核对 skill 边界", "改挂 package lane", "继续只跑工厂产包"],
    });
  });

  test("标题——长说明 只取短标题做 soft", () => {
    const r = detectChoiceOffer(
      "建议下一步可以：\n1. **继续 App 方向**——按你的背景展开差异化方向\n2. **推进提审准备**——把构建和隐私清单跑完\n3. **先放一放**——等你下次有空再说",
    );
    expect(r?.kind).toBe("soft");
    if (r?.kind === "soft") {
      expect(r.options).toEqual(["继续 App 方向", "推进提审准备", "先放一放"]);
    }
  });

  test("纯说明列表 → null", () => {
    expect(detectChoiceOffer("今天做了三件事：\n1. 修了输入框高度\n2. 修了录制条重复\n3. 重启了应用")).toBeNull();
  });

  test("不足两条 → null", () => {
    expect(detectChoiceOffer("你可以选：\n1. 只看文件")).toBeNull();
  });

  test("几乎全是短枚举 → soft", () => {
    const r = detectChoiceOffer("1. 核对 skill 边界\n2. 改挂 package lane\n3. 继续工厂产包");
    expect(r).toEqual({
      kind: "soft",
      options: ["核对 skill 边界", "改挂 package lane", "继续工厂产包"],
    });
  });

  test("工具围栏内容不干扰", () => {
    const r = detectChoiceOffer("你选哪个？\n1. 甲\n2. 乙\n```tool\n{\"tool\":\"ui.ask\"}\n```");
    expect(r?.kind).toBe("hard");
    if (r?.kind === "hard") expect(r.options).toEqual(["甲", "乙"]);
  });
});
