'use client';

export default function ErrorBoundary({
  reset,
}: {
  readonly error: Error;
  readonly reset: () => void;
}) {
  return (
    <section className="card card-pad" role="alert">
      <h2>Something went wrong</h2>
      <p className="muted">The page failed to render. Please try again.</p>
      <button type="button" className="btn primary" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
