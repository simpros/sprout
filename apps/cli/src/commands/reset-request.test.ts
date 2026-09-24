import { describe, expect, test } from "bun:test";
import {
  classifyResetRequest,
  RESET_BOX_SNIPPET,
  stripFencedCodeBlocks,
  untickResetBox,
} from "./reset-request.ts";

const MARKER = "<!-- sprout-reset: ada-1 -->";

function resetMarkerOf(body: string | null): string | null {
  const outcome = classifyResetRequest({ body, truncated: false });
  return outcome.kind === "reset" ? outcome.marker : null;
}

describe("classifyResetRequest reset path", () => {
  test.each(["- [x]", "- [X]", "* [x]"])(
    "ticked box %s with marker fires",
    (box) => {
      expect(
        resetMarkerOf(`${box} Sprout: reset preview\n${MARKER}`),
      ).toBe("ada-1");
    },
  );

  test("marker on the same line as the box fires", () => {
    expect(
      resetMarkerOf(`- [x] Sprout: reset preview ${MARKER}`),
    ).toBe("ada-1");
  });

  test("unticked box with marker does not fire", () => {
    expect(
      resetMarkerOf(`- [ ] Sprout: reset preview\n${MARKER}`),
    ).toBeNull();
  });

  test("ticked box without marker does not fire", () => {
    expect(resetMarkerOf("- [x] Sprout: reset preview")).toBeNull();
  });

  test("empty marker does not fire", () => {
    expect(
      resetMarkerOf(
        "- [x] Sprout: reset preview\n<!-- sprout-reset: -->",
      ),
    ).toBeNull();
  });

  test("marker-like comment without colon does not fire", () => {
    expect(
      resetMarkerOf("- [x] Sprout: reset preview\n<!-- sprout-reset -->"),
    ).toBeNull();
  });

  test("no box and no marker does not fire", () => {
    expect(resetMarkerOf("Just a normal description.")).toBeNull();
    expect(resetMarkerOf(null)).toBeNull();
    expect(resetMarkerOf("")).toBeNull();
  });

  test("ticked box inside a fenced code block does not fire", () => {
    expect(
      resetMarkerOf(
        ["```", "- [x] Sprout: reset preview", MARKER, "```"].join("\n"),
      ),
    ).toBeNull();
  });

  test("marker inside a fenced code block does not fire", () => {
    expect(
      resetMarkerOf(
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
      resetMarkerOf(
        ["~~~", "- [x] Sprout: reset preview", MARKER, "~~~"].join("\n"),
      ),
    ).toBeNull();
  });

  test("unrelated checkboxes do not fire", () => {
    expect(
      resetMarkerOf(`- [x] Run the linter\n${MARKER}`),
    ).toBeNull();
  });

  test("latest marker token wins", () => {
    expect(
      resetMarkerOf(
        [
          "- [x] Sprout: reset preview",
          "<!-- sprout-reset: old -->",
          "<!-- sprout-reset: new -->",
        ].join("\n"),
      ),
    ).toBe("new");
  });

  test("shipped snippet is inert until ticked with a fresh token", () => {
    expect(resetMarkerOf(RESET_BOX_SNIPPET)).toBeNull();
    expect(
      resetMarkerOf(
        RESET_BOX_SNIPPET.replace("- [ ]", "- [x]").replace("TOKEN", "ada-2"),
      ),
    ).toBe("ada-2");
  });
});

describe("classifyResetRequest truncation path", () => {
  test("visible request wins even when truncated", () => {
    expect(
      classifyResetRequest({
        body: `- [x] Sprout: reset preview\n${MARKER}`,
        truncated: true,
      }),
    ).toEqual({ kind: "reset", marker: "ada-1" });
  });

  test("ticked box without marker is unreadable when truncated", () => {
    expect(
      classifyResetRequest({
        body: "- [x] Sprout: reset preview",
        truncated: true,
      }),
    ).toEqual({ kind: "truncated-unreadable" });
  });

  test("no reset signal is truncated-none when truncated", () => {
    expect(
      classifyResetRequest({ body: "Just a long description.", truncated: true }),
    ).toEqual({ kind: "truncated-none" });
  });

  test("untruncated bodies without a request are none", () => {
    expect(
      classifyResetRequest({ body: "Just a description.", truncated: false }),
    ).toEqual({ kind: "none" });
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
