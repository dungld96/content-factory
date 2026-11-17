import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="card">
      <h2>Page not found</h2>
      <Link href="/">Back to home</Link>
    </section>
  );
}
