import { Fragment } from "react";

/**
 * A mechanism drawn as nodes joined by moving dashes, words only. A node that is an array stacks its labels, as a fork
 * (several sources, or several destinations). `accent` marks the node the strip is about.
 */
export type FlowNode = string | string[];

export function FlowStrip({ nodes, accent, label, className }: { nodes: FlowNode[]; accent?: string; label: string; className?: string }) {
  return (
    <div className={`flow${className ? ` ${className}` : ""}`} role="img" aria-label={label} data-inview="">
      {nodes.map((n, i) => (
        <Fragment key={i}>
          {i > 0 ? <i className="flow-link" aria-hidden="true" /> : null}
          {Array.isArray(n) ? (
            <span className="flow-fork">
              {n.map((m) => (
                <span key={m} className={`flow-node${m === accent ? " is-accent" : ""}`}>{m}</span>
              ))}
            </span>
          ) : (
            <span className={`flow-node${n === accent ? " is-accent" : ""}`}>{n}</span>
          )}
        </Fragment>
      ))}
    </div>
  );
}
