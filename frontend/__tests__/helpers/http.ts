// Shared JSON Response builder for fetch-mock tests, replacing the ten
// hand-rolled `jsonResponse` copies that had drifted on parameter order
// (`(status, body)` in the `.ts` API tests vs `(data, status)` in the `.tsx`
// tests — a copy-between-files trap) and on 204-no-body handling (#332).
// Standardized on `(data, status = 200)`, the majority order, and folds in the
// 204 path so a no-body status yields a spec-valid bodyless Response (the
// Response constructor rejects a body on a 204).
export function jsonResponse(data: unknown, status = 200): Response {
  const isNoBody = status === 204;
  return new Response(isNoBody ? null : JSON.stringify(data), {
    status,
    headers: isNoBody ? undefined : { 'Content-Type': 'application/json' },
  });
}
