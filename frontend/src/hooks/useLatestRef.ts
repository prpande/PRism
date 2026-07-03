import { useRef } from 'react';

// Returns a ref that always holds the latest value, assigned during render.
// For stable-identity callbacks that must read current state (latest-ref idiom).
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
