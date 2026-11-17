import Link from 'next/link';

export default function HomePage() {
  return (
    <>
      <h1>AI Content Factory</h1>
      <p className="muted">
        Turn a content brief into an approved, downloadable vertical video — with traceable prompts,
        assets, jobs, providers and cost.
      </p>
      <section className="card" aria-labelledby="empty-state">
        <h2 id="empty-state">No projects yet</h2>
        <p className="muted">
          Projects and content items arrive in milestone M1. For now, check that the platform is
          wired up on the <Link href="/status">system status</Link> page.
        </p>
      </section>
    </>
  );
}
