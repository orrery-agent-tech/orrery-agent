/* eslint-disable @next/next/no-img-element */
import type { ReactNode } from "react";

/** Header for product pages: kicker, title, lead and one object from the Orrery set. */
export function PageHead({ kicker, title, lead, art, titleClass }: { kicker: string; title: ReactNode; lead?: ReactNode; art: string; titleClass?: string }) {
  return (
    <header className="page-head">
      <div className="page-head-copy">
        <p className="kicker">{kicker}</p>
        <h1 className={titleClass}><span className="rl"><span>{title}</span></span></h1>
        {lead ? <div className="page-head-lead">{lead}</div> : null}
      </div>
      <img className="page-head-art" src={`/art/${art}.webp`} alt="" aria-hidden="true" />
    </header>
  );
}
