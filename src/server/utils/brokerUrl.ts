/**
 * Strip `user:password@` from a broker URL before it reaches a log line.
 *
 * Credentials normally arrive in the `username` / `password` options, but
 * nothing stops an operator typing `mqtts://user:secret@host`, and every
 * connect/drop/flap log line carries the URL (#5596).
 */
export function redactBrokerUrl(url: string): string {
  // Greedy up to the LAST `@` before the path: a password may itself hold an
  // `@`, and stopping at the first one would leave its tail in the log.
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/i, '$1***@');
}
