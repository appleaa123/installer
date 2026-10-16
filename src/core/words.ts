import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Check words (spec 5.1, D159): one of 32 short words and four characters of D77's alphabet, for example
 * HERON-7K3P. About 25 bits, so a word is stored only as a slow, salted hash: a fast hash could be reversed by
 * an agent running as the same computer user in under a second (plan review, finding 1).
 */
export const WORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const WORDS: readonly string[] = [
  "HERON", "KESTREL", "OSPREY", "PELICAN", "FALCON", "ROBIN", "WREN", "LARK", "FINCH", "SWIFT", "EGRET", "IBIS", "CRANE", "PLOVER", "TERN", "RAVEN",
  "MAGPIE", "OWL", "HAWK", "EAGLE", "DOVE", "GULL", "LINNET", "SISKIN", "THRUSH", "MARTIN", "BUNTING", "CURLEW", "DUNLIN", "GANNET", "PUFFIN", "KITE",
];
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const HASH_BYTES = 32;

const pick = <T>(list: readonly T[], byte: number): T => list[byte % list.length] as T;

export function newWord(): string {
  const bytes = randomBytes(5);
  const tail = [...bytes.subarray(1)].map((byte) => pick([...WORD_ALPHABET], byte)).join("");
  return `${pick(WORDS, bytes[0] ?? 0)}-${tail}`;
}

/** What a comparison ignores: case, spaces and dashes. */
export const normalizeWord = (text: string): string => text.toUpperCase().replace(/[\s-]+/g, "");
export const sameWord = (typed: string, expected: string): boolean => normalizeWord(typed) === normalizeWord(expected);

export const newSalt = (): string => randomBytes(16).toString("hex");
export const hashWord = (word: string, salt: string): string => scryptSync(normalizeWord(word), Buffer.from(salt, "hex"), HASH_BYTES, SCRYPT).toString("hex");

export function verifyWord(typed: string, salt: string, hash: string): boolean {
  const expected = Buffer.from(hash, "hex");
  const actual = Buffer.from(hashWord(typed, salt), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
