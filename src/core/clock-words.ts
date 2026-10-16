/**
 * A moment in words for the person (review M3): the date, the time and the time zone of this computer, so a check that
 * runs past midnight, or is read from a phone in another zone, never says "today" or a bare time.
 */
export function whenWords(iso: string, zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const date = new Date(iso);
  const words = date.toLocaleString("en-US", { timeZone: zone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${words} (${zone} time)`;
}
