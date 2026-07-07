/** Parse a user-entered decimal amount ("1,200.50") into integer cents, or null if invalid. */
export function parseAmountToCents(input: string): number | null {
  const cleaned = input.replace(/,/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

export function centsToAmountString(cents: number): string {
  return (cents / 100).toFixed(2);
}
