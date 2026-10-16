const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/**
 * Keeps the `dark` class on `<html>` in step with the OS color scheme, which Electron reports
 * through `prefers-color-scheme`. It applies the current scheme immediately, so call it before the
 * first render to avoid a flash. Returns a function that stops listening.
 */
export function syncColorScheme(root: HTMLElement = document.documentElement): () => void {
  const query = window.matchMedia(DARK_SCHEME_QUERY);

  const apply = (isDark: boolean): void => {
    root.classList.toggle('dark', isDark);
  };
  const onChange = (event: MediaQueryListEvent): void => {
    apply(event.matches);
  };

  apply(query.matches);
  query.addEventListener('change', onChange);

  return () => {
    query.removeEventListener('change', onChange);
  };
}
