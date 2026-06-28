/** Format an integer won amount with Korean thousands separators, no unit. */
export function formatWonAmount(amount: number): string {
  return new Intl.NumberFormat("ko-KR").format(amount);
}
