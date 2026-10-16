import { describe, expect, it } from "vitest";
import { WORDS, WORD_ALPHABET, hashWord, newSalt, newWord, normalizeWord, sameWord, verifyWord } from "../../src/core/words.js";

/** Spec 5.1: words use D77's alphabet, two parts, typing-tolerant; stored only as a slow salted hash (plan review 1). */
describe("words", () => {
  it("makes a word from the word list and four alphabet characters", () => {
    for (let index = 0; index < 50; index += 1) {
      const [head, tail] = newWord().split("-");
      expect(WORDS).toContain(head);
      expect(tail).toMatch(new RegExp(`^[${WORD_ALPHABET}]{4}$`));
    }
    expect(WORDS).toHaveLength(32);
  });

  it("compares ignoring case, spaces and dashes", () => {
    expect(sameWord("heron 7k3p", "HERON-7K3P")).toBe(true);
    expect(sameWord(" Heron-7K3P ", "HERON7K3P")).toBe(true);
    expect(sameWord("HERON-7K3Q", "HERON-7K3P")).toBe(false);
    expect(normalizeWord("a-b c")).toBe("ABC");
  });

  it("stores a slow salted hash that verifies the typed word and nothing else", () => {
    const salt = newSalt();
    const hash = hashWord("HERON-7K3P", salt);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(hashWord("HERON-7K3P", newSalt()));
    expect(verifyWord("heron 7k3p", salt, hash)).toBe(true);
    expect(verifyWord("HERON-7K3Q", salt, hash)).toBe(false);
  });

  it("is slow enough that guessing every word takes far too long", () => {
    const salt = newSalt();
    const started = performance.now();
    hashWord("HERON-7K3P", salt);
    // One hash costs milliseconds; 33 million guesses would take days.
    expect(performance.now() - started).toBeGreaterThan(5);
  });
});
