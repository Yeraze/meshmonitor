/**
 * Strip `user:password@` from a broker URL before it reaches a log line.
 *
 * Credentials normally arrive in the `username` / `password` options, but
 * nothing stops an operator typing `mqtts://user:secret@host`, and every
 * connect/drop/flap log line carries the URL (#5596).
 */
export function redactBrokerUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1***@');
}
