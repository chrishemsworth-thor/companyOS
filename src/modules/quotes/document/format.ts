import type { QuoteTemplateConfig } from "../branding";

type NumberFormat = QuoteTemplateConfig["number_format"];
type DateFormat = QuoteTemplateConfig["date_format"];

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Group the integer part of a fixed-2-decimals number per the chosen format. */
export function formatAmount(cents: number, fmt: NumberFormat): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");

  const groupSep = fmt === "1.234,56" ? "." : ",";
  const decimalSep = fmt === "1.234,56" ? "," : ".";
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, groupSep);
  return `${negative ? "-" : ""}${grouped}${decimalSep}${frac}`;
}

/** Money with a currency prefix, e.g. "RM 1,234.56" for MYR, else "MYR 1,234.56". */
export function formatMoney(cents: number, currency: string, fmt: NumberFormat): string {
  const symbol = currency === "MYR" ? "RM" : currency;
  return `${symbol} ${formatAmount(cents, fmt)}`;
}

/** Format an ISO date (YYYY-MM-DD or full ISO) per the chosen format. */
export function formatDate(iso: string | null, fmt: DateFormat): string {
  if (!iso) return "—";
  const datePart = iso.slice(0, 10);
  const [y, m, d] = datePart.split("-");
  if (!y || !m || !d) return datePart;
  switch (fmt) {
    case "YYYY-MM-DD":
      return `${y}-${m}-${d}`;
    case "DD MMM YYYY":
      return `${d} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
    case "DD/MM/YYYY":
    default:
      return `${d}/${m}/${y}`;
  }
}
