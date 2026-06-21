import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Today's date as YYYY-MM-DD in Korea Standard Time — the business date used for
 * request/plan/report fields. The viewer's UTC date (new Date().toISOString())
 * records the PREVIOUS day during 00:00–09:00 KST, so always resolve in
 * Asia/Seoul regardless of the browser's timezone. en-CA yields ISO YYYY-MM-DD.
 */
export function todayInSeoul(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}
