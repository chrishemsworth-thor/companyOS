/**
 * Curated ISO 4217 codes offered in currency pickers. The backend accepts any
 * 3-letter code — this list only drives the dropdown, MYR-first because
 * CompanyOS ships Malaysia-first (SST, MYR defaults).
 */
export const CURRENCIES = [
  { code: "MYR", label: "MYR — Malaysian Ringgit" },
  { code: "SGD", label: "SGD — Singapore Dollar" },
  { code: "USD", label: "USD — US Dollar" },
  { code: "EUR", label: "EUR — Euro" },
  { code: "GBP", label: "GBP — British Pound" },
  { code: "AUD", label: "AUD — Australian Dollar" },
  { code: "NZD", label: "NZD — New Zealand Dollar" },
  { code: "JPY", label: "JPY — Japanese Yen" },
  { code: "CNY", label: "CNY — Chinese Yuan" },
  { code: "HKD", label: "HKD — Hong Kong Dollar" },
  { code: "TWD", label: "TWD — New Taiwan Dollar" },
  { code: "KRW", label: "KRW — South Korean Won" },
  { code: "IDR", label: "IDR — Indonesian Rupiah" },
  { code: "THB", label: "THB — Thai Baht" },
  { code: "VND", label: "VND — Vietnamese Dong" },
  { code: "PHP", label: "PHP — Philippine Peso" },
  { code: "INR", label: "INR — Indian Rupee" },
  { code: "AED", label: "AED — UAE Dirham" },
  { code: "SAR", label: "SAR — Saudi Riyal" },
  { code: "CAD", label: "CAD — Canadian Dollar" },
  { code: "CHF", label: "CHF — Swiss Franc" },
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number]["code"];
