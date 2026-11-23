// A token estimate without a tokenizer. Budgets and cap estimates need a
// number that is close and never far under, not an exact count, and a
// tokenizer would add a megabyte per model family. English runs about four
// characters a token; Bangla and other scripts run nearer one and a half, so
// those count heavier. The estimate leans high on purpose.

/** Estimated tokens in a text. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let ascii = 0
  let other = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4 + other / 1.5)
}

/**
 * The longest start of `text` that fits in `budget` estimated tokens, cut at
 * a line or word end when one is near, never inside a character.
 */
export function truncateToTokens(text: string, budget: number): string {
  if (budget <= 0) return ''
  if (estimateTokens(text) <= budget) return text
  const chars = [...text]
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimateTokens(chars.slice(0, mid).join('')) <= budget) lo = mid
    else hi = mid - 1
  }
  const cut = chars.slice(0, lo).join('')
  const soft = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '))
  return soft > cut.length * 0.8 ? cut.slice(0, soft) : cut
}
