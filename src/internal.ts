/**
 * Small helpers shared verbatim by every core module (task, project, query,
 * lifecycle, deps): the error-text formatting of received values and the
 * uniform "an input is a JSON object (or nothing)" read. Kept dependency-free
 * so any module can import it without layering concerns.
 */

/**
 * Renders a received value for an error message: JSON text (strings come out
 * quoted, so empty strings and lookalikes stay visible), falling back to
 * String(...) for the few values JSON cannot express.
 */
export function display(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/**
 * Reads an input as a JSON object shape; anything that is not an object
 * (null, arrays fall through as objects here, scalars) is treated as "no
 * keys", letting the per-field parsers produce the specific invalid error.
 */
export function asBody(input: unknown): Record<string, unknown> {
  return (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
}
