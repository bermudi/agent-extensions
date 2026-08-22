import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ModelMultiSelect } from "./ui.ts";

describe("ModelMultiSelect", () => {
  test("rejects duplicate-only model lists", () => {
    expect(
      () =>
        new ModelMultiSelect(
          ["same", "same"],
          () => {},
          () => {},
        ),
    ).toThrow("two distinct models");
  });

  test("never renders beyond a narrow terminal width", () => {
    const picker = new ModelMultiSelect(
      ["one", "two"],
      () => {},
      () => {},
    );
    expect(picker.render(20).every((line) => visibleWidth(line) <= 20)).toBe(
      true,
    );
  });

  test("keeps the cursor in place while toggling selections", () => {
    let renders = 0;
    let result: string[] | null | undefined;
    const picker = new ModelMultiSelect(
      ["one", "two", "three"],
      () => renders++,
      (value) => {
        result = value;
      },
    );

    picker.handleInput("\x1b[B");
    picker.handleInput("\x1b[B");
    picker.handleInput(" ");
    const lines = picker.render(80);

    expect(lines).toContain("› [x] three");
    expect(lines).not.toContain("› [ ] one");
    expect(renders).toBe(3);
    expect(result).toBeUndefined();
  });

  test("starts only after two models are selected", () => {
    let result: string[] | null | undefined;
    const picker = new ModelMultiSelect(
      ["one", "two"],
      () => {},
      (value) => {
        result = value;
      },
    );

    picker.handleInput(" ");
    picker.handleInput("\x1b[B");
    picker.handleInput(" ");
    picker.handleInput("\x1b[B");
    picker.handleInput("\r");

    expect(result).toEqual(["one", "two"]);
  });
});
