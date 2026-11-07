import { assert, describe, it } from "@effect/vitest";

import { parseElicitationForm } from "./elicitationForm.ts";

describe("parseElicitationForm", () => {
  for (const type of ["string", "array"] as const) {
    it.each([
      { values: [" padded ", "", "plain"], labels: ["padded", '""', "plain"] },
      { values: [" a", "a", "b"], labels: ['" a"', '"a"', "b"] },
      { values: [" a", "a", '"a"'], labels: ['" a"', '"a"', '"\\"a\\""'] },
    ])(
      `preserves ${type} enum values with distinct readable labels: $values`,
      ({ values, labels }) => {
        const form = parseElicitationForm(
          {
            type: "object",
            properties: {
              answer:
                type === "array"
                  ? { type, items: { type: "string", enum: values } }
                  : { type, enum: values },
            },
            required: ["answer"],
          },
          "Choose",
        );
        assert(form !== undefined);
        const question = form.questions[0];
        assert(question !== undefined);
        assert.deepStrictEqual(
          question.options.map((option) => option.label),
          labels,
        );
        assert.deepStrictEqual(
          question.options.map((option) => option.value),
          values,
        );
        assert.strictEqual(question.allowCustomAnswer, false);
        assert.strictEqual(question.multiSelect, type === "array" ? true : undefined);
        for (const value of values) {
          const answer = type === "array" ? [value] : value;
          assert.deepStrictEqual(form.content({ answer }), { answer });
        }
      },
    );
  }

  it("carries array selection bounds through the question contract", () => {
    const form = parseElicitationForm(
      {
        type: "object",
        properties: {
          answer: {
            type: "array",
            minItems: 2,
            maxItems: 2,
            items: { type: "string", enum: ["first", "second", "third"] },
          },
        },
        required: ["answer"],
      },
      "Choose two",
    );
    assert(form !== undefined);
    assert.deepStrictEqual(form.questions[0], {
      id: "answer",
      header: "Question 1",
      question: "Choose two",
      options: [
        { label: "first", description: "first", value: "first" },
        { label: "second", description: "second", value: "second" },
        { label: "third", description: "third", value: "third" },
      ],
      allowCustomAnswer: false,
      multiSelect: true,
      minItems: 2,
      maxItems: 2,
    });
    assert.strictEqual(form.content({ answer: ["first"] }), undefined);
    assert.deepStrictEqual(form.content({ answer: ["first", "second"] }), {
      answer: ["first", "second"],
    });
  });
});
