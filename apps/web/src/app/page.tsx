import Link from 'next/link';

export default function HomePage() {
  return (
    <>
      <h1>AI Content Factory</h1>
      <p className="muted">
        Turn a content brief into an approved, downloadable vertical video — with traceable prompts,
        assets, jobs, providers and cost.
      </p>
      <section className="card" aria-labelledby="get-started">
        <h2 id="get-started">Get started</h2>
        <p className="muted">
          <Link href="/login">Sign in</Link> to see your <Link href="/projects">projects</Link>, or
          check that the platform is wired up on the <Link href="/status">system status</Link> page.
        </p>
      </section>
    </>
  );
}
