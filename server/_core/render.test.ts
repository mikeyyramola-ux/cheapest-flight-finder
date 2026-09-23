import { describe, expect, it } from "vitest";
import { DESTINATIONS } from "@shared/destinations";
import { clipOnWord, destinationHead } from "./render";

describe("head meta", () => {
  it("keeps every destination title/description within SERP limits and un-truncated", () => {
    for (const dest of DESTINATIONS) {
      const head = destinationHead(dest, `/flights-to/${dest.slug}`);
      expect(head.title.length, `${dest.city} title: ${head.title}`).toBeLessThanOrEqual(70);
      expect(head.description.length, `${dest.city} description: ${head.description}`).toBeLessThanOrEqual(155);
      // A word-boundary clip trims trailing punctuation — its presence proves no truncation fired.
      expect(head.description.endsWith("."), `${dest.city} description: ${head.description}`).toBe(true);
      expect(head.description.includes("  "), `${dest.city} description must be single-spaced`).toBe(false);
    }
  });

  it("clips long text on a word boundary instead of mid-token", () => {
    expect(clipOnWord("one two three", 100)).toBe("one two three");
    expect(clipOnWord("alpha beta gamma", 11)).toBe("alpha beta");
    expect(clipOnWord("alpha beta gamma", 10)).toBe("alpha beta");
    expect(clipOnWord("alpha beta", 5)).toBe("alpha");
    expect(clipOnWord("supercalifragilistic expialidocious", 10)).toBe("supercalif");
    expect(clipOnWord("word1 word2.", 6)).toBe("word1");
  });
});
