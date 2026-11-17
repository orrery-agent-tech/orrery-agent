/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { ContractAddress } from "@/components/ContractAddress";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PayerConsole } from "@/components/PayerConsole";
import { Faq } from "@/components/motion/Faq";
import { FlowStrip } from "@/components/motion/Flow";
import { Magnetic, Tilt } from "@/components/motion/Pointer";

const FACTS = [
  "Agents carry ERC-8004 identities",
  "Settled in USDG over x402",
  "Caps per payment, per day and on the float",
  "A raised cap waits one hour or more",
  "Readings signed under EIP-712",
  "Running on Robinhood Chain",
];

const STEPS = [
  { art: "gate-set", title: "Plot", text: "The operator plots the caps and the allowed calls on the agent's account." },
  { art: "gate-pay", title: "Pay", text: "From its own signer, the agent pays in USDG and never leaves those caps." },
  { art: "gate-check", title: "Read", text: "The merchant takes a reading of the address that paid." },
  { art: "gate-sign", title: "Sign", text: "Orrery sends back the caps and the live state together, in one signed reading." },
];

const JOBS = [
  { art: "job-cap", title: "Bound the spend.", text: "Ceilings per payment, per day and on the float decide how much the agent may move." },
  { art: "job-wait", title: "Let every rise show.", text: "A higher cap needs at least one hour to apply, so each increase sits on record before it counts." },
  { art: "job-route", title: "Chart the path.", text: "Allowed calls name the contracts the agent may reach. No other contract is open to it." },
];


const AUDIENCES = [
  { art: "agent-tag", who: "Operators", title: "Your AI agent spends money.", text: "Give it bounds it stays inside: caps per payment, per day and on the float, the contracts it may call, and a public wait before any cap rises.", href: "/operator", cta: "Plot an orbit" },
  { art: "signer-lookup", who: "Merchants", title: "AI agents pay you.", text: "Before you accept, take a reading of the paying address and get it back signed: the agent's identity, its caps and today's spend.", href: "/signer", cta: "Take a reading" },
  { art: "credits-pack", who: "ORRY holders", title: "You hold ORRY.", text: "Collect swap fees from the ORRY pools, stake for part of Orrery's revenue, and see supply burn as the product is used.", href: "/earn", cta: "Explore ORRY" },
];

const ORRY_USES = [
  { title: "Earn", text: "Supply the ORRY/ETH or ORRY/USDG pool. Earn shares receive 85% of each swap fee, streamed over 7 days.", href: "/earn", cta: "Go to Earn" },
  { title: "Stake", text: "Every active stake receives pool fees and ORRY bought with Orrery's USDG revenue, paid in ETH and ORRY.", href: "/stake", cta: "Go to Stake" },
  { title: "Spend and burn", text: "Credit packs and agent verifications accept ORRY, and each ORRY spent on them burns in that same transaction.", href: "/burn", cta: "View the burns" },
];

const FAQ = [
  { q: "What counts as an agent payment?", a: "An AI agent buying an API call, data or a service on its own, in USDG over x402, with the payment carried inside the HTTP request." },
  { q: "Could an agent spend past its caps?", a: "No. The caps sit in the policy module on the agent's own Safe, and each payment is checked on chain before funds move. A higher cap waits at least one hour, in public view." },
  { q: "What does a merchant get back from a reading?", a: "A record of the payer signed under EIP-712: session status, agent identity, caps, today's spend and the most recent endpoint probe. The SDK checks the signature for you." },
  { q: "Where does Orrery run?", a: "On Robinhood Chain. Agents hold ERC-8004 identities, accounts are Safe 1.4.1 with an ERC-7579 module, and payments settle in USDG." },
  { q: "What role does ORRY play?", a: "It earns from the ORRY pools, stakes for part of Orrery's revenue, and pays for readings and verifications, where it is burned." },
];

const CODE = `import { OrreryApi, verifyCheck } from "@orrery-tech/sdk";

const api = new OrreryApi("https://api.orreryagent.com", apiKey);
const res = await api.checkPayer(payer);
const v = await verifyCheck(publicClient, attestor, res, { payer });

if (v.ok) {
  v.result.status;        // active · paused · revoked
  v.result.caps;          // per payment, daily, float
  v.result.endpointsLive; // most recent endpoint probe
}`;

/** The SDK sample, one line per row so the lines can arrive in turn; comments in their own colour. */
function CodeLines({ code }: { code: string }) {
  const lines = code.split("\n");
  return (
    <pre className="lp-code" data-reveal="code">
      <code>
        {lines.map((l, i) => {
          const at = l.indexOf("//");
          return (
            <span key={i} className="cl" style={{ ["--i" as string]: i }}>
              {at >= 0 ? (
                <>
                  {l.slice(0, at)}
                  <span className="cc">{l.slice(at)}</span>
                </>
              ) : (
                l || "\u00a0"
              )}
              {i === lines.length - 1 ? <span className="caret" aria-hidden="true" /> : null}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

export default function Home() {
  return (
    <div className="lp">
      <div className="lp-hero-wrap">
        <Nav />
        <section className="lp-hero">
          <div className="lp-hero-copy">
            <h1>
              <span className="rl"><span>Every agent payment</span></span>
              <span className="rl"><span className="accent">on a visible orbit.</span></span>
            </h1>
            <p className="lp-lead load-rise" style={{ ["--d" as string]: "0.28s" }}>Plot public caps for the agent that pays. Whoever receives its USDG can take a reading of the payer and get that reading back signed.</p>
            <div className="lp-actions load-rise" style={{ ["--d" as string]: "0.38s" }}>
              <Magnetic><Link className="btn btn-brand" href="/dashboard/agents">Plot an orbit</Link></Magnetic>
              <Link className="btn btn-ghost" href="/signer">Take a reading</Link>
            </div>
            <ContractAddress />
          </div>
          <div className="lp-hero-stage">
            <Tilt className="hero-tilt" max={4}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="lp-hero-plate" src="/art/orrery-plate.webp" alt="A rose gold mechanical orrery: blued steel planets and one ruby planet on fixed orbits around a polished sun" width={1040} height={768} fetchPriority="high" />
            </Tilt>
            <PayerConsole />
          </div>
        </section>
      </div>

      <div className="lp-marquee" aria-label="Orrery at a glance">
        <div className="lp-marquee-track">
          {[...FACTS, ...FACTS].map((f, i) => (
            <span key={i}>{f}</span>
          ))}
        </div>
      </div>


      <section className="lp-section lp-dark" id="how">
        <div className="lp-head">
          <p className="kicker">The course of a payment</p>
          <h2 data-reveal="lines"><span className="rl"><span>From plotted caps</span></span><span className="rl"><span>to a signed reading.</span></span></h2>
        </div>
        <div className="lp-steps-wrap" data-inview="">
        <ol className="lp-steps" data-reveal="">
          {STEPS.map((s, i) => (
            <li key={s.art}>
              <div className="lp-gate-art">
                <img src={`/art/${s.art}.webp`} alt="" width={800} height={800} loading="lazy" />
                {i < STEPS.length - 1 ? <span className="lp-gate-link" aria-hidden="true"><i /></span> : null}
              </div>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
        </div>
      </section>

      <section className="lp-section lp-paper lp-who" aria-labelledby="who-h">
        <div className="lp-head">
          <p className="kicker">Three readers of one payment</p>
          <h2 id="who-h" data-reveal="lines"><span className="rl"><span>Each side sees</span></span><span className="rl"><span>the same orbit.</span></span></h2>
        </div>
        <div className="lp-who-grid" data-reveal="group">
          {AUDIENCES.map((a) => (
            <article key={a.who}>
              <img className="lp-who-art" src={`/art/${a.art}.webp`} alt="" aria-hidden="true" width={112} height={112} loading="lazy" />
              <p className="lp-who-tag">{a.who}</p>
              <h3>{a.title}</h3>
              <p>{a.text}</p>
              <Link className="lp-link" href={a.href}>{a.cta}</Link>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section lp-dark lp-split">
        <div>
          <p className="kicker">For merchants</p>
          <h2 data-reveal="lines"><span className="rl"><span>Read the payer</span></span><span className="rl"><span>before you serve.</span></span></h2>
          <p className="lp-copy">A single call returns the live caps, today&apos;s spend, the state of the agent&apos;s endpoints, and a signed reading your own code can verify.</p>
          <Link className="lp-link" href="/docs">Open the developer guide</Link>
        </div>
        <CodeLines code={CODE} />
      </section>

      <section className="lp-section lp-paper">
        <div className="lp-head">
          <p className="kicker">What the bounds do</p>
          <h2 data-reveal="lines"><span className="rl"><span>Three bounds, each in plain view.</span></span></h2>
        </div>
        <div className="lp-jobs" data-reveal="group">
          {JOBS.map((j) => (
            <article key={j.art} className="lp-job">
              <div className="lp-job-art"><img src={`/art/${j.art}.webp`} alt="" width={1024} height={768} loading="lazy" /></div>
              <h3>{j.title}</h3>
              <p>{j.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section lp-dark lp-orry" aria-labelledby="orry-h">
        <div className="lp-head">
          <p className="kicker">ORRY</p>
          <h2 id="orry-h" data-reveal="lines"><span className="rl"><span>ORRY, fed by what</span></span><span className="rl"><span>Orrery earns.</span></span></h2>
          <p className="lp-copy">Verifications and readings bring Orrery revenue in USDG. Most of it buys ORRY, which goes to stakers or is burned, while swap fees from the ORRY pools flow to Earn.</p>
          <div className="lp-flows" data-reveal="group">
            <FlowStrip label="USDG revenue buys ORRY for stakers and for the burn" nodes={["USDG revenue", "ORRY bought", ["Stakers", "Burn"]]} accent="ORRY bought" />
            <FlowStrip label="Swap fees from the ORRY pools flow to Earn" nodes={["Swap fees", "Earn"]} accent="Earn" />
          </div>
        </div>
        <ol className="lp-orry-uses" data-reveal="group">
          {ORRY_USES.map((u) => (
            <li key={u.title}>
              <h3>{u.title}</h3>
              <p>{u.text}</p>
              <Link className="lp-link" href={u.href}>{u.cta}</Link>
            </li>
          ))}
        </ol>
      </section>

      <section className="lp-section lp-ground lp-split lp-operator">
        <div>
          <p className="kicker">For operators</p>
          <h2 data-reveal="lines"><span className="rl"><span>Adjust the orbit</span></span><span className="rl"><span>with the reading in view.</span></span></h2>
          <p className="lp-copy">Today&apos;s spend is drawn against the daily cap. Each policy field shows its live value beside it, and a raised cap waits out the delay you chose.</p>
          <Link className="lp-link" href="/dashboard/agents">Go to the operator console</Link>
        </div>
        <div className="lp-operator-stage">
          <Tilt className="lp-operator-art"><div className="float"><img src="/art/operator-console.webp" alt="" width={800} height={800} loading="lazy" /></div></Tilt>
            <div className="lp-editor" aria-label="Preview of the policy editor" data-reveal="" style={{ ["--d" as string]: "0.15s" }}>
              <div className="lp-editor-head"><b>Agent policy</b><span>Preview</span></div>
              <div className="lp-editor-reading">
                <span>Spent today</span>
                <small>measured against the daily cap</small>
                <div className="console-track"><i style={{ width: "32%" }} /></div>
              </div>
              <dl className="lp-editor-fields">
                <div><dt>Per payment</dt><dd>Set by you</dd></div>
                <div><dt>Float ceiling</dt><dd>Set by you</dd></div>
                <div><dt>Allowed calls</dt><dd>Contracts you allow</dd></div>
                <div><dt>Increase delay</dt><dd>At least 1 hour</dd></div>
              </dl>
            </div>
        </div>
      </section>

      <section className="lp-section lp-paper lp-split lp-credits">
        <Tilt className="lp-credits-art"><div className="float"><img src="/art/credits-pack.webp" alt="" width={800} height={800} loading="lazy" /></div></Tilt>
        <div>
          <p className="kicker">Pricing</p>
          <h2 data-reveal="lines"><span className="rl"><span>Pay per reading,</span></span><span className="rl"><span>less as volume grows.</span></span></h2>
          <p className="lp-copy">One wallet signature gets you an API key. Every address includes 1,000 checks a month. Beyond those, each check costs 0.004 USDG, falling to 0.002 USDG past 100,000 checks a month, paid with credits bought in USDG over x402 or in ORRY. Verifying an agent is a single payment by its operator.</p>
          <div className="lp-actions">
            <Magnetic><Link className="btn btn-brand" href="/dashboard/credits">Create an API key</Link></Magnetic>
            <Link className="btn btn-ghost" href="/docs">Read how readings work</Link>
          </div>
        </div>
      </section>

      <section className="lp-section lp-ground lp-faq" aria-labelledby="faq-h">
        <div className="lp-head">
          <p className="kicker">Asked often</p>
          <h2 id="faq-h" data-reveal="lines"><span className="rl"><span>Plain answers, on record.</span></span></h2>
        </div>
        <Faq items={FAQ} />
      </section>
      <Footer />
    </div>
  );
}
