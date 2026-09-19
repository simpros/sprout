import { describe, expect, test } from "bun:test";
import {
  parseResetRequest,
  RESET_BOX_SNIPPET,
  stripFencedCodeBlocks,
  untickResetBox,
} from "./reset-request.ts";

const MARKER = "<!-- sprout-reset: ada-1 -->";

describe("parseResetRequest", () => {
  test.each(["- [x]", "- [X]", "* [x]"])(
    "ticked box %s with marker fires",
    (box) => {
      expect(
        parseResetRequest(`${box} Sprout: reset preview\n${MARKER}`),
      ).toBe("ada-1");
    },
  );

  test("marker on the same line as the box fires", () => {
    expect(
      parseResetRequest(`- [x] Sprout: reset preview ${MARKER}`),
    ).toBe("ada-1");
  });

  test("unticked box with marker does not fire", () => {
    expect(
      parseResetRequest(`- [ ] Sprout: reset preview\n${MARKER}`),
    ).toBeNull();
  });

  test("ticked box without marker does not fire", () => {
    expect(parseResetRequest("- [x] Sprout: reset preview")).toBeNull();
  });

  test("empty marker does not fire", () => {
    expect(
      parseResetRequest(
        "- [x] Sprout: reset preview\n<!-- sprout-reset: -->",
      ),
    ).toBeNull();
  });

  test("marker-like comment without colon does not fire", () => {
    expect(
      parseResetRequest("- [x] Sprout: reset preview\n<!-- sprout-reset -->"),
    ).toBeNull();
  });

  test("no box and no marker does not fire", () => {
    expect(parseResetRequest("Just a normal description.")).toBeNull();
    expect(parseResetRequest(null)).toBeNull();
    expect(parseResetRequest("")).toBeNull();
  });

  test("ticked box inside a fenced code block does not fire", () => {
    expect(
      parseResetRequest(
        ["```", "- [x] Sprout: reset preview", MARKER, "```"].join("\n"),
      ),
    ).toBeNull();
  });

  test("marker inside a fenced code block does not fire", () => {
    expect(
      parseResetRequest(
        [
          "- [x] Sprout: reset preview",
          "```",
          MARKER,
          "```",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  test("tilde fences also hide the request", () => {
    expect(
      parseResetRequest(
        ["~~~", "- [x] Sprout: reset preview", MARKER, "~~~"].join("\n"),
      ),
    ).toBeNull();
  });

  test("unrelated checkboxes do not fire", () => {
    expect(
      parseResetRequest(`- [x] Run the linter\n${MARKER}`),
    ).toBeNull();
  });

  test("latest marker token wins", () => {
    expect(
      parseResetRequest(
        [
          "- [x] Sprout: reset preview",
          "<!-- sprout-reset: old -->",
          "<!-- sprout-reset: new -->",
        ].join("\n"),
      ),
    ).toBe("new");
  });

  test("shipped snippet is inert until ticked with a fresh token", () => {
    expect(parseResetRequest(RESET_BOX_SNIPPET)).toBeNull();
    expect(
      parseResetRequest(
        RESET_BOX_SNIPPET.replace("- [ ]", "- [x]").replace("TOKEN", "ada-2"),
      ),
    ).toBe("ada-2");
  });
});

describe("stripFencedCodeBlocks", () => {
  test("keeps plain text untouched", () => {
    expect(stripFencedCodeBlocks("a\nb")).toBe("a\nb");
  });
});

describe("untickResetBox", () => {
  test("flips ticked boxes, preserves marker and other lines", () => {
    const body = [
      "Some intro",
      "- [x] Sprout: reset preview",
      MARKER,
      "- [x] Unrelated task",
    ].join("\n");
    expect(untickResetBox(body)).toBe(
      [
        "Some intro",
        "- [ ] Sprout: reset preview",
        MARKER,
        "- [x] Unrelated task",
      ].join("\n"),
    );
  });

  test("handles same-line marker and capital X", () => {
    expect(
      untickResetBox(`- [X] Sprout: reset preview ${MARKER}`),
    ).toBe(`- [ ] Sprout: reset preview ${MARKER}`);
  });

  test("returns null when nothing is ticked", () => {
    expect(
      untickResetBox(`- [ ] Sprout: reset preview\n${MARKER}`),
    ).toBeNull();
  });

  test("leaves fenced ticks alone", () => {
    const body = ["```", "- [x] Sprout: reset preview", "```"].join("\n");
    expect(untickResetBox(body)).toBeNull();
  });
});
