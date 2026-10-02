import { describe, expect, it } from "vitest";
import { replayTyping, smartTypography } from "./typography";

describe("replayTyping", () => {
  it("catches up on several characters typed between checks", () => {
    // `"a" --> it's` typed in one burst after `x `.
    expect(replayTyping("x ", '"a" --> it\'s')).toEqual({ from: 2, insert: "“a” → it’s" });
  });

  it("can rewrite into the prefix (en dash + hyphen → em dash)", () => {
    expect(replayTyping("a –", "-")).toEqual({ from: 2, insert: "—" });
  });

  it("returns null when nothing changes", () => {
    expect(replayTyping("plain ", "text")).toBeNull();
  });

  it("only touches what was typed — an earlier straight quote stays", () => {
    // The `"` in the prefix was typed before (and maybe deliberately undone).
    expect(replayTyping('say "', "hi")).toBeNull();
  });
});

/** Simulate typing `input` one character at a time, applying each fix the
 *  way the editor does (replace the trailing characters at the caret). */
function type(input: string): string {
  let text = "";
  for (const ch of input) {
    text += ch;
    const fix = smartTypography(text);
    if (fix) text = text.slice(0, text.length - fix.remove) + fix.insert;
  }
  return text;
}

describe("smartTypography", () => {
  it("turns hyphens into en and em dashes", () => {
    expect(type("a -- b")).toBe("a – b");
    expect(type("a---b")).toBe("a—b");
  });

  it("makes an ellipsis", () => {
    expect(type("and then...")).toBe("and then…");
  });

  it("curls double quotes by position", () => {
    expect(type('She said "it\'s fine" then')).toBe("She said “it’s fine” then");
    expect(type('("quoted")')).toBe("(“quoted”)");
  });

  it("curls single quotes and apostrophes", () => {
    expect(type("don't")).toBe("don’t");
    expect(type("writers' room")).toBe("writers’ room");
    expect(type("'quoted'")).toBe("‘quoted’");
    expect(type("back in '90s")).toBe("back in ’90s");
  });

  it("renders arrows", () => {
    expect(type("a -> b")).toBe("a → b");
    expect(type("a --> b")).toBe("a → b");
    expect(type("a <- b")).toBe("a ← b");
    expect(type("a <-- b")).toBe("a ← b");
    expect(type("a <-> b")).toBe("a ↔ b");
    expect(type("a <--> b")).toBe("a ↔ b");
    expect(type("a => b")).toBe("a ⇒ b");
  });

  it("leaves ordinary text alone", () => {
    expect(smartTypography("plain text")).toBeNull();
    expect(type("x > y and a - b")).toBe("x > y and a - b");
  });
});
