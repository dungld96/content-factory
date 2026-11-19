import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="standalone">
      <section className="card standalone-card">
        <h1>Page not found</h1>
        <p className="modal-desc">It may have been moved, archived, or you may not have access.</p>
        <Link className="btn primary" href="/">
          Back to the workspace
        </Link>
      </section>
    </div>
  );
}
