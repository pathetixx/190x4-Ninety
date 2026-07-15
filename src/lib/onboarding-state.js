export function shouldShowOnboarding({ sourceEmpty, done }) {
  return !!sourceEmpty && !done;
}
