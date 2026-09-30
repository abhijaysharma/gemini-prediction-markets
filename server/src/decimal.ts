// Prices and quantities arrive as decimal strings. We keep them as strings
// so we never accumulate floating-point error. An L2 feed only *replaces*
// quantities at a price, it never adds them, so no arithmetic is needed.
// The one thing we must do is canonicalize, so "0.480" and "0.48" are the
// same price level.

export function normDecimal(input: string | number): string {
  let s = String(input).trim();
  if (s.startsWith("+")) s = s.slice(1);
  if (!s.includes(".")) {
    return s.replace(/^0+(?=\d)/, "");
  }
  const [intPart, fracPart] = s.split(".");
  const i = intPart.replace(/^0+(?=\d)/, "") || "0";
  const f = fracPart.replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}

export function isZero(q: string | number): boolean {
  return Number(q) === 0;
}
