/**
 * A thin bar along the toolbar's bottom edge while the selected tab loads. It is absolutely
 * positioned, so showing it never moves anything. Under `prefers-reduced-motion` it is a still bar.
 */
export function LoadingBar({ active }: { readonly active: boolean }) {
  return (
    <div
      aria-hidden="true"
      data-loading-indicator=""
      data-loading={active}
      className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden"
    >
      {active ? (
        <div className="h-full w-2/5 animate-indeterminate bg-primary motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-50" />
      ) : null}
    </div>
  );
}
