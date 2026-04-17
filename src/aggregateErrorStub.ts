/**
 * aggregate-error browser stub for BYOC plugin.
 * The original aggregate-error uses node:url (fileURLToPath) which is not
 * available in browser environments (Obsidian plugin context).
 * This provides a minimal drop-in replacement compatible with the usage in main.ts.
 */

class AggregateError extends Error {
  errors: readonly Error[];

  constructor(errors: Iterable<Error>, message?: string) {
    const errorArray = [...errors];
    super(message ?? errorArray.map((e) => e.message).join("; "));
    this.name = "AggregateError";
    this.errors = errorArray;
  }

  [Symbol.iterator]() {
    return this.errors[Symbol.iterator]();
  }
}

export default AggregateError;
