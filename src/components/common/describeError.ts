/** Readable text for a thrown value, whether or not it is an `Error`.
 *  Libraries can throw plain strings (leaflet.markercluster does, #5516). */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
