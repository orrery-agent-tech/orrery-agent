import type { ReactNode } from "react";

export type GuideStep = { title: string; text: ReactNode };

/** "Who this page is for" and the steps it takes, in order. Sits under the page head on every product page. */
export function PageGuide({ audience, steps, note }: { audience: ReactNode; steps: GuideStep[]; note?: ReactNode }) {
  return (
    <section className="guide" aria-label="Using this page">
      <p className="guide-for">
        <span>For</span>
        {audience}
      </p>
      <ol className="guide-steps" data-reveal="group">
        {steps.map((s, i) => (
          <li key={s.title}>
            <span className="guide-n" aria-hidden="true">{i + 1}</span>
            <h3>{s.title}</h3>
            <p>{s.text}</p>
          </li>
        ))}
      </ol>
      {note ? <p className="guide-note">{note}</p> : null}
    </section>
  );
}

/** What a result on this page looks like, before there is one. Labels only, never invented values. */
export function ResultPreview({ title, rows, foot }: { title: string; rows: [string, string][]; foot?: ReactNode }) {
  return (
    <aside className="preview" aria-label={title}>
      <p className="preview-title">{title}</p>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {foot ? <p className="preview-foot">{foot}</p> : null}
    </aside>
  );
}
