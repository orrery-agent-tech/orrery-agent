import Link from "next/link";
import { Brand } from "./Brand";
import { X_HANDLE, X_URL } from "./social";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-footer-main">
        <Brand />
        <p>Agent payments, bounded and on record.</p>
      </div>
      <nav className="site-footer-links" aria-label="Footer">
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/signer">Readings</Link>
        <Link href="/docs">Docs</Link>
        {X_URL ? <a href={X_URL} target="_blank" rel="noreferrer">{X_HANDLE}</a> : null}
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
      </nav>
    </footer>
  );
}
