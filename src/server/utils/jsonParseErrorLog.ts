/**
 * Log line for a request body that failed JSON parsing. Never includes
 * `err.message`: recent Node quotes part of the body there, and a body can hold
 * a secret (PUT /api/script-secrets). Type and position only.
 */
export function describeJsonParseError(err: Error): string {
  const type = (err as Error & { type?: string }).type ?? 'entity.parse.failed';
  const position = /position (\d+)/.exec(err.message)?.[1];
  return `JSON parsing error: ${type}${position ? ` at position ${position}` : ''}`;
}
