/**
 * Deeply strips `readonly` from a type.
 *
 * The domain model is immutable by design, but Zod infers mutable arrays for `z.array(...)`, so a
 * handler returning a domain object cannot be assigned to its own output schema type. Rather than
 * weaken the domain model or deep-clone every response, handlers cast at the transport boundary —
 * the value never escapes the JSON serialiser, so nothing can actually mutate it.
 */
export type Writable<T> = T extends readonly (infer Element)[]
  ? Writable<Element>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Writable<T[Key]> }
    : T;

export const writable = <T>(value: T): Writable<T> => value as Writable<T>;
