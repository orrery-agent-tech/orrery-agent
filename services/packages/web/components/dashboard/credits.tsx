"use client";

import Link from "next/link";
import { useState } from "react";
import { formatUnits, type Address, type Hex } from "viem";
import { useConnection, useSignMessage, useSignTypedData } from "wagmi";
import { API_URL, activeChain } from "@/lib/config";
import { buyCredits, rotateApiKey, useAccount, useAccountSession, usePricing, useRefreshAccount, type AccountView, type Pricing, type Product } from "@/lib/credits/account";
import { useReleases } from "@/lib/orry/releases";
import { orry } from "@/lib/orry/format";
import { OrryCheckoutSlot } from "../orry/slots";
import { TxLink } from "../orry/parts";
import { TryCheck } from "./TryCheck";
import { Empty, Loading, Panel, Rows, Stat } from "./ui";

const n = (v: number | string) => Number(v).toLocaleString("en-US");
const usdg = (base: string | bigint) => Number(formatUnits(BigInt(base), 6)).toLocaleString("en-US", { maximumFractionDigits: 6 });
const date = (iso: string) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const dateTime = (iso: string) => `${new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC`;
const monthName = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const perCheck = (p: Pricing, credits: number) => usdg((BigInt(p.packPrice) * BigInt(credits)) / BigInt(p.packSize));

/** Shared by the Credits section and the overview: the wallet's read session and its account. */
function useCreditsAccount() {
  const { address } = useConnection();
  const { signMessageAsync } = useSignMessage();
  const session = useAccountSession(address as Address | undefined, (message) => signMessageAsync({ message }) as Promise<Hex>);
  const account = useAccount(session.token, session.expired);
  return { address: address as Address, session, account };
}

function SignIn({ busy, error, onSignIn, compact = false }: { busy: boolean; error: string | null; onSignIn: () => void; compact?: boolean }) {
  return (
    <div className="cp-empty">
      <p>
        {compact
          ? "One signed message shows your credits here."
          : "One signed message from this wallet opens your credits, purchases and usage. No gas, read only, valid on this device for 24 hours."}
      </p>
      <button className="cp-btn cp-btn-primary" type="button" onClick={onSignIn} disabled={busy}>
        {busy ? "Awaiting your signature" : "Show my credits"}
      </button>
      {error ? <p className="cp-note" role="alert">{error}</p> : null}
    </div>
  );
}

// ------------------------------------------------------------------ overview panel

export function CreditsSummary() {
  const { session, account } = useCreditsAccount();
  const a = account.data;
  return (
    <Panel title="Credits" action={{ href: "/dashboard/credits", label: a ? "Manage" : "Open" }}>
      {!API_URL ? (
        <Empty text="Your credits show here as soon as checks run on this network." />
      ) : !session.token ? (
        <SignIn compact busy={session.busy} error={session.error} onSignIn={() => void session.signIn()} />
      ) : !a ? (
        <Loading />
      ) : (
        <Rows
          rows={[
            ["Credits", n(a.credits)],
            ["Included checks remaining", `${n(a.month.freeChecksLeft)} of ${n(a.month.freeChecks + a.month.freeChecksLeft)}`],
            ["Checks so far this month", n(a.month.checks)],
            ["Plan", a.planUntil ? `Active until ${date(a.planUntil)}` : "None"],
          ]}
        />
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ credits section

/** The price list alone, for a visitor who has not connected a wallet yet (the dashboard's connect screen on Credits). */
export function CreditsPrices() {
  const pricing = usePricing().data;
  if (!API_URL || !pricing) return null;
  return (
    <Panel title="Prices per check" className="cp-guest">
      <Rows
        rows={[
          [`First ${n(pricing.freeChecksPerMonth)} each month`, "Included"],
          [`Through ${n(pricing.volumeChecks)} in a month`, `${perCheck(pricing, pricing.creditsPerCheck)} USDG per check`],
          [`Beyond ${n(pricing.volumeChecks)} in a month`, `${perCheck(pricing, pricing.volumeCreditsPerCheck)} USDG per check`],
          ["Credit pack", `${n(pricing.packSize)} credits · ${usdg(pricing.packPrice)} USDG`],
          ["Monthly plan", `${n(pricing.plan.credits)} credits over ${pricing.plan.days} days · ${usdg(pricing.plan.price)} USDG`],
        ]}
      />
    </Panel>
  );
}

export function CreditsView() {
  const { address, session, account } = useCreditsAccount();
  const { chainId } = useConnection();
  const { signTypedDataAsync } = useSignTypedData();
  const { signMessageAsync } = useSignMessage();
  const pricing = usePricing().data;
  const refresh = useRefreshAccount();
  const releases = useReleases();
  const [busy, setBusy] = useState<Product | "key" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | ""; text: string } | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const onChain = chainId === activeChain.id;
  const a = account.data;

  async function buy(product: Product) {
    setBusy(product);
    setNotice(null);
    try {
      const out = await buyCredits({
        address,
        product,
        signTypedData: (args) => signTypedDataAsync(args as never) as Promise<Hex>,
        onPending: () => setNotice({ tone: "", text: "Confirming the payment." }),
      });
      if (out.apiKey) setNewKey(out.apiKey);
      setNotice({
        tone: "ok",
        text: product === "plan" && out.planUntil ? `Plan is active through ${date(out.planUntil)}, with ${n(out.credits)} credits on hand.` : `Credits added. You now hold ${n(out.credits)} credits.`,
      });
      void refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setNotice({ tone: "error", text: /reject|denied/i.test(msg) ? "You closed the signature request." : msg || "The purchase was not completed." });
    } finally {
      setBusy(null);
    }
  }

  async function rotate() {
    setBusy("key");
    setNotice(null);
    try {
      setNewKey(await rotateApiKey(address, (message) => signMessageAsync({ message }) as Promise<Hex>));
      setNotice({ tone: "ok", text: "Key issued. Every older key for this address is now retired." });
      void refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setNotice({ tone: "error", text: /reject|denied/i.test(msg) ? "You closed the signature request." : msg || "No key was issued." });
    } finally {
      setBusy(null);
    }
  }

  if (!API_URL) return <Empty text="Your credits show here as soon as checks run on this network." />;

  const included = a ? a.month.freeChecks + a.month.freeChecksLeft : pricing?.freeChecksPerMonth;
  const usedShare = a && included ? Math.min(100, Math.round((a.month.freeChecks / included) * 100)) : 0;
  const maxDay = Math.max(1, ...(a?.usage.daily ?? []).map((d) => d.checks));

  return (
    <div className="cp-stack">
      <div className="cp-stats">
        <Stat label="Credits" value={a ? n(a.credits) : session.token ? undefined : "Sign in"} />
        <Stat label="Included checks remaining" value={a ? n(a.month.freeChecksLeft) : session.token ? undefined : "Sign in"} hint={included ? `out of ${n(included)} for this month` : undefined} />
        <Stat label="Checks so far this month" value={a ? n(a.month.checks) : session.token ? undefined : "Sign in"} />
        <Stat label="Plan" value={a ? (a.planUntil ? `Until ${date(a.planUntil)}` : "None") : session.token ? undefined : "Sign in"} />
      </div>

      {notice ? (
        <p className={`cp-note${notice.tone ? ` is-${notice.tone}` : ""}`} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
        </p>
      ) : null}

      {!session.token ? (
        <Panel title="Your credits">
          <SignIn busy={session.busy} error={session.error} onSignIn={() => void session.signIn()} />
        </Panel>
      ) : null}

      <div className="cp-grid">
        <Panel title="Buy credits">
          {!pricing ? (
            <Loading lines={2} />
          ) : (
            <div className="cp-buy">
              <div className="cp-buy-option">
                <h3>Credit pack</h3>
                <p className="cp-buy-price">{usdg(pricing.packPrice)} USDG</p>
                <p>
                  {n(pricing.packSize)} credits. Each check uses {pricing.creditsPerCheck} credits ({perCheck(pricing, pricing.creditsPerCheck)} USDG), dropping to {pricing.volumeCreditsPerCheck} credit once a month passes {n(pricing.volumeChecks)} checks.
                </p>
                <button className="cp-btn cp-btn-primary" type="button" onClick={() => void buy("pack")} disabled={!onChain || busy !== null}>
                  {busy === "pack" ? "Buying" : `Buy the pack, ${usdg(pricing.packPrice)} USDG`}
                </button>
              </div>
              <div className="cp-buy-option">
                <h3>Monthly plan</h3>
                <p className="cp-buy-price">{usdg(pricing.plan.price)} USDG</p>
                <p>
                  {n(pricing.plan.credits)} credits for {pricing.plan.days} days. Each check uses 1 credit, at up to {n(pricing.plan.checksPerMinute)} checks a minute.
                </p>
                <button className="cp-btn" type="button" onClick={() => void buy("plan")} disabled={!onChain || busy !== null}>
                  {busy === "plan" ? "Buying" : `Buy the plan, ${usdg(pricing.plan.price)} USDG`}
                </button>
              </div>
              <p className="cp-muted">
                One USDG payment signature in your wallet, with no gas. Every address also gets {n(pricing.freeChecksPerMonth)} included checks each month, spent before any credits.
                {!onChain ? ` To buy, move your wallet to ${activeChain.name}.` : ""}
              </p>
              {releases.isLive("checkout") ? <OrryCheckoutSlot /> : null}
            </div>
          )}
        </Panel>

        <Panel title="API key">
          <Rows
            rows={[
              ["Status", a ? (a.apiKey.active ? "Active" : "Not issued") : session.token ? "…" : "Sign in first"],
              ["Issued", a?.apiKey.createdAt ? date(a.apiKey.createdAt) : "None"],
              ["Used for", "Your server's signed checks, through the SDK"],
            ]}
          />
          {newKey ? (
            <div className="cp-key">
              <p>
                <strong>API key, shown one time.</strong> Put it on your server before you leave this page.
              </p>
              <code className="mono">{newKey}</code>
              <button
                className="cp-btn"
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(newKey).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  });
                }}
              >
                {copied ? "Copied" : "Copy key"}
              </button>
              <p>
                <strong>A first check.</strong> Send one request from a terminal, or call <code>checkPayment</code> from the SDK.
              </p>
              <pre className="cp-snippet">{`curl -H "authorization: Bearer ${newKey}" \\\n  ${API_URL}/v1/check/by-signer/0xPAYING_ADDRESS`}</pre>
            </div>
          ) : null}
          <div className="cp-actions">
            <button className="cp-btn" type="button" onClick={() => void rotate()} disabled={!onChain || busy !== null}>
              {busy === "key" ? "Awaiting your signature" : a?.apiKey.active ? "Replace the key" : "Issue my API key"}
            </button>
            <Link className="cp-link" href="/docs">
              Using the key
            </Link>
          </div>
          {a?.apiKey.active ? <p className="cp-muted">Issuing a key retires the current one immediately.</p> : null}
        </Panel>
      </div>

      <Panel title="Test a check">
        <TryCheck apiKey={newKey} onChecked={() => void refresh()} />
      </Panel>

      {session.token ? (
        <>
          <Panel title="This month's included checks">
            {!a ? (
              <Loading lines={1} />
            ) : (
              <div className="cp-meter">
                <span className="cp-bar" aria-hidden="true">
                  <i style={{ width: `${usedShare}%` }} />
                </span>
                <p>
                  {n(a.month.freeChecks)} of {n(included ?? 0)} used. The count resets on the first day of every month, UTC, and each check past it takes {a.checkCost} {a.checkCost === 1 ? "credit" : "credits"}.
                </p>
              </div>
            )}
          </Panel>

          <Panel title="Daily checks, past 30 days">
            {!a ? (
              <Loading />
            ) : !a.usage.daily.length ? (
              <Empty text="This address has run no checks in the past 30 days." action={{ href: "/docs", label: "Run a first check" }} />
            ) : (
              <div className="cp-table-wrap">
                <table className="cp-table">
                  <thead>
                    <tr>
                      <th>Day (UTC)</th>
                      <th className="num">Checks</th>
                      <th className="num">Included</th>
                      <th className="num">Credits spent</th>
                      <th aria-hidden="true" />
                    </tr>
                  </thead>
                  <tbody>
                    {a.usage.daily.map((d) => (
                      <tr key={d.day}>
                        <td>{date(`${d.day}T00:00:00Z`)}</td>
                        <td className="num">{n(d.checks)}</td>
                        <td className="num">{n(d.freeChecks)}</td>
                        <td className="num">{n(d.creditsSpent)}</td>
                        <td className="cp-spark">
                          <span className="cp-bar" aria-hidden="true">
                            <i style={{ width: `${Math.round((d.checks / maxDay) * 100)}%` }} />
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <div className="cp-grid">
            <Panel title="Monthly">
              {!a ? (
                <Loading />
              ) : !a.usage.monthly.length ? (
                <Empty text="Totals by month start with your first check." />
              ) : (
                <div className="cp-table-wrap">
                  <table className="cp-table">
                    <thead>
                      <tr>
                        <th>Month</th>
                        <th className="num">Checks</th>
                        <th className="num">Included</th>
                        <th className="num">Paid</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.usage.monthly.map((m) => (
                        <tr key={m.month}>
                          <td>{monthName(m.month)}</td>
                          <td className="num">{n(m.checks)}</td>
                          <td className="num">{n(m.freeChecks)}</td>
                          <td className="num">{n(m.paidChecks)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel title="Purchases">
              {!a ? <Loading /> : !a.purchases.length ? <Empty text="This address has made no purchases yet." /> : <Purchases rows={a.purchases} />}
            </Panel>
          </div>

          <p className="cp-muted">
            This device stays signed in as this wallet for 24 hours.{" "}
            <button className="cp-link" type="button" onClick={() => void session.signOut()}>
              Sign out
            </button>
          </p>
        </>
      ) : null}
    </div>
  );
}

function Purchases({ rows }: { rows: AccountView["purchases"] }) {
  return (
    <div className="cp-table-wrap">
      <table className="cp-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Product</th>
            <th className="num">Paid</th>
            <th className="num">Credits</th>
            <th>Transaction</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={`${p.at}-${i}`}>
              <td>{dateTime(p.at)}</td>
              <td>{p.product === "plan" ? "Monthly plan" : "Credit pack"}</td>
              <td className="num">{p.amount ? `${p.paidIn === "USDG" ? usdg(p.amount) : orry(BigInt(p.amount.split(".")[0]!))} ${p.paidIn}` : p.paidIn}</td>
              <td className="num">{n(p.credits)}</td>
              <td>{p.tx ? <TxLink hash={p.tx as Hex} /> : "Confirming"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
