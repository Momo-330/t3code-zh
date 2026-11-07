import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  isPendingUserInputOptionDisabled,
  isPendingUserInputOptionSelected,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput.ts";

const singleSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    { label: "Orchestration-first", description: "Focus on orchestration first" },
    { label: "Node.js", description: "Reuse TypeScript" },
  ],
  multiSelect: false,
} as const;

const nativeChoiceQuestion = {
  id: "result",
  header: "Result",
  question: "Which result should be used?",
  options: [
    { value: " first\t", label: "Result", description: "First result" },
    { value: "second", label: "Result", description: "Second result" },
  ],
  allowCustomAnswer: false,
  multiSelect: false,
} as const;

describe("resolvePendingUserInputAnswer", () => {
  it("requires the provider's minimum and maximum multi-select counts", () => {
    const question = {
      ...singleSelectQuestion,
      options: [...singleSelectQuestion.options, { label: "third", description: "A third option" }],
      multiSelect: true,
      minItems: 2,
      maxItems: 2,
    };
    const oneSelected = { selectedOptionValues: ["Orchestration-first"] };
    const twoSelected = { selectedOptionValues: ["Orchestration-first", "Node.js"] };
    const threeSelected = {
      selectedOptionValues: ["Orchestration-first", "Node.js", "third"],
    };

    expect(resolvePendingUserInputAnswer(question, oneSelected)).toBeNull();
    expect(buildPendingUserInputAnswers([question], { scope: oneSelected })).toBeNull();
    expect(resolvePendingUserInputAnswer(question, twoSelected)).toEqual([
      "Orchestration-first",
      "Node.js",
    ]);
    expect(buildPendingUserInputAnswers([question], { scope: twoSelected })).toEqual({
      scope: ["Orchestration-first", "Node.js"],
    });
    expect(resolvePendingUserInputAnswer(question, threeSelected)).toBeNull();
  });
  it("preserves exact editor text, including a deliberately cleared answer", () => {
    const question = { ...singleSelectQuestion, initialAnswer: "  Proposed message\n" };
    expect(resolvePendingUserInputAnswer(question, { customAnswer: question.initialAnswer })).toBe(
      question.initialAnswer,
    );
    expect(resolvePendingUserInputAnswer(question, { customAnswer: "  Edited message\n\n" })).toBe(
      "  Edited message\n\n",
    );
    expect(resolvePendingUserInputAnswer(question, { customAnswer: "" })).toBe("");
    expect(resolvePendingUserInputAnswer(question, { customAnswer: " \n" })).toBe(" \n");
    expect(
      setPendingUserInputCustomAnswer(
        question,
        { selectedOptionValues: ["Orchestration-first"] },
        "",
      ),
    ).toEqual({ customAnswer: "" });
  });

  it("prefers a custom answer over selected options", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionValues: ["Orchestration-first"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("does not replace a required choice with a custom answer", () => {
    expect(
      resolvePendingUserInputAnswer(nativeChoiceQuestion, {
        selectedOptionValues: ["second"],
        customAnswer: "Use another result",
      }),
    ).toBe("second");
  });

  it("does not submit labels or unknown values when an option has a value", () => {
    expect(
      resolvePendingUserInputAnswer(nativeChoiceQuestion, {
        selectedOptionValues: ["Result", "unknown"],
      }),
    ).toBeNull();
  });

  it("matches a label only for an option without a value", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, { selectedOptionValues: [" Node.js "] }),
    ).toBe("Node.js");
  });

  it("accepts ready attachment-only answers while preserving selected options", () => {
    expect(resolvePendingUserInputAnswer(singleSelectQuestion, { attachmentCount: 1 })).toBe("");
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        attachmentCount: 1,
        selectedOptionValues: ["Node.js"],
      }),
    ).toBe("Node.js");
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        attachmentCount: 1,
        attachmentsBlocked: true,
      }),
    ).toBeNull();
    expect(
      resolvePendingUserInputAnswer(
        { ...singleSelectQuestion, allowCustomAnswer: false },
        { attachmentCount: 1 },
      ),
    ).toBeNull();
  });
});

describe("togglePendingUserInputOptionSelection", () => {
  it("prevents selecting beyond the maximum while allowing a selection to be removed", () => {
    const question = {
      ...singleSelectQuestion,
      options: [...singleSelectQuestion.options, { label: "third" }],
      multiSelect: true,
      maxItems: 2,
    };
    const first = togglePendingUserInputOptionSelection(question, undefined, "Orchestration-first");
    const both = togglePendingUserInputOptionSelection(question, first, "Node.js");

    expect(isPendingUserInputOptionDisabled(question, both, "third")).toBe(true);
    expect(togglePendingUserInputOptionSelection(question, both, "third")).toBe(both);
    expect(togglePendingUserInputOptionSelection(question, both, "Node.js")).toEqual({
      customAnswer: "",
      selectedOptionValues: ["Orchestration-first"],
    });
  });
  it("selects and removes options with the same label independently", () => {
    const question = { ...nativeChoiceQuestion, multiSelect: true };
    const firstSelected = togglePendingUserInputOptionSelection(question, undefined, " first\t");
    const bothSelected = togglePendingUserInputOptionSelection(question, firstSelected, "second");

    expect(buildPendingUserInputAnswers([question], { result: bothSelected })).toEqual({
      result: [" first\t", "second"],
    });

    const secondSelected = togglePendingUserInputOptionSelection(
      question,
      bothSelected,
      " first\t",
    );
    expect(buildPendingUserInputAnswers([question], { result: secondSelected })).toEqual({
      result: ["second"],
    });
  });

  it("submits raw option values and leaves the draft alone for an unknown option", () => {
    const first = togglePendingUserInputOptionSelection(
      nativeChoiceQuestion,
      undefined,
      " first\t",
    );
    expect(isPendingUserInputOptionSelected(nativeChoiceQuestion, first, " first\t")).toBe(true);
    expect(isPendingUserInputOptionSelected(nativeChoiceQuestion, first, "second")).toBe(false);
    expect(buildPendingUserInputAnswers([nativeChoiceQuestion], { result: first })).toEqual({
      result: " first\t",
    });
    expect(togglePendingUserInputOptionSelection(nativeChoiceQuestion, first, "Result")).toBe(
      first,
    );
  });
});

describe("setPendingUserInputCustomAnswer", () => {
  it("rejects arbitrary text when the provider only accepts offered options", () => {
    expect(setPendingUserInputCustomAnswer(nativeChoiceQuestion, undefined, "Other")).toEqual({});
    expect(
      buildPendingUserInputAnswers([nativeChoiceQuestion], { result: { customAnswer: "Other" } }),
    ).toBeNull();
    expect(
      buildPendingUserInputAnswers([nativeChoiceQuestion], {
        result: { selectedOptionValues: ["second"], customAnswer: "stale draft" },
      }),
    ).toEqual({ result: "second" });
  });
});

const compatQuestion = {
  id: "compat",
  header: "Compat",
  question: "How strict should compatibility be?",
  options: [{ label: "Keep current envelope", description: "Preserve current wire format" }],
  multiSelect: false,
} as const;

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers([singleSelectQuestion, compatQuestion], {
        scope: { selectedOptionValues: ["Orchestration-first"] },
        compat: { customAnswer: "Keep the current envelope for one release window" },
      }),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });
});

it.each([
  ["single-select", singleSelectQuestion, ["Orchestration-first"], '"Orchestration-first"'],
  [
    "multi-select",
    {
      ...singleSelectQuestion,
      multiSelect: true,
      options: [{ label: "Server" }, { label: "Web" }],
    },
    ["Server", "Web"],
    '["Server","Web"]',
  ],
])("sends a %s answer to a question with the id __proto__", (_kind, question, selected, json) => {
  const answers = buildPendingUserInputAnswers(
    [
      { ...question, id: "__proto__" },
      { ...singleSelectQuestion, id: "name" },
    ],
    {
      ["__proto__"]: { selectedOptionValues: selected },
      name: { selectedOptionValues: ["Orchestration-first"] },
    },
  );

  expect(JSON.stringify(answers)).toBe(`{"__proto__":${json},"name":"Orchestration-first"}`);
});
