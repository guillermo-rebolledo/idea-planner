/**
 * The one rule for text this app keeps or forwards. It lives on its own so
 * every durable contract can reach it without importing the Conversation.
 */

/** Removes credential-shaped text before anything is stored or presented. */
export function redactCredentials(value: string): string {
  return value.replace(
    /(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
    '$1=[REDACTED: credential]'
  )
}
