// Coerce a raw, server-sent error `code` to a known member of a typed union,
// falling back when it isn't recognized. Used by the discriminated error results so
// an unknown future code (during a server schema-bump window) is never cast-laundered
// into the union — where a downstream exhaustive switch would silently mis-bucket it.
// The raw server `message` is surfaced separately, so an unmapped code is still
// visible to the user, just not mistyped. (#330)
//
// This is the coercion form. The type-GUARD form (`code is T`, feeding an exhaustive
// switch) is a different shape — see isKnownSubmitErrorCode in ./submit.
export function coerceToKnownCode<T extends string>(
  known: readonly T[],
  raw: unknown,
  fallback: T,
): T {
  return typeof raw === 'string' && (known as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}
