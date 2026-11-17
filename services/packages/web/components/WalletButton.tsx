"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain, type Connector } from "wagmi";
import { activeChain, WALLET_DIRECTORY_URL } from "@/lib/config";
import { short } from "@/lib/format";
import { DASHBOARD_HREF } from "@/lib/dashboard";

/**
 * Brand-neutral wallet control. Wallet names and icons come from each wallet's EIP-6963 announcement. One wallet in the
 * browser connects straight away; a picker opens only when there are several. No wallet sends the visitor to a
 * directory, never to one vendor.
 */
export function WalletButton() {
  const connection = useConnection();
  const connectors = useConnectors();
  const { mutateAsync: connectAsync, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { mutateAsync: switchChainAsync } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [hasFallbackProvider, setHasFallbackProvider] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
    setHasFallbackProvider(typeof window !== "undefined" && Boolean((window as unknown as { ethereum?: unknown }).ethereum));
  }, []);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const options = useMemo(() => {
    const announced = connectors.filter((c) => c.id !== "injected");
    if (announced.length > 0) return announced;
    const fallback = connectors.find((c) => c.id === "injected");
    return fallback && hasFallbackProvider ? [fallback] : [];
  }, [connectors, hasFallbackProvider]);

  async function connect(c: Connector) {
    setOpen(false);
    setNotice(null);
    try {
      await connectAsync({ connector: c, chainId: activeChain.id });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setNotice(/reject|denied/i.test(msg) ? "Request dismissed in the wallet." : "The wallet stayed disconnected. Try again.");
    }
  }

  if (!mounted) {
    return (
      <button className="wallet" type="button" disabled>
        Connect wallet
      </button>
    );
  }

  if (connection.isConnected && connection.address) {
    if (connection.chainId !== activeChain.id) {
      return (
        <button className="wallet warn" type="button" onClick={() => switchChainAsync({ chainId: activeChain.id }).catch(() => setNotice("Pick " + activeChain.name + " in the wallet to continue."))}>
          Switch to {activeChain.name}
        </button>
      );
    }
    return (
      <div className="wallet-wrap" ref={ref}>
        <button className="wallet connected" type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {short(connection.address)}
        </button>
        {open && (
          <div className="wallet-menu" role="menu">
            <p className="mono">{connection.address}</p>
            <Link href={DASHBOARD_HREF} onClick={() => setOpen(false)}>
              Dashboard
            </Link>
            <button type="button" onClick={() => { disconnect(); setOpen(false); }}>
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wallet-wrap" ref={ref}>
      <button
        className="wallet"
        type="button"
        disabled={isPending}
        onClick={() => {
          if (options.length === 1) void connect(options[0]!);
          else setOpen((o) => !o);
        }}
        aria-expanded={open}
      >
        {isPending ? "Approve in your wallet" : "Connect wallet"}
      </button>
      {open && (
        <div className="wallet-menu" role="menu">
          {options.length === 0 ? (
            <>
              <p>This browser holds no wallet yet. On a phone, load this page inside your wallet app&apos;s own browser.</p>
              <a href={WALLET_DIRECTORY_URL} target="_blank" rel="noreferrer">Browse wallets</a>
            </>
          ) : (
            options.map((c) => (
              <button key={c.uid} type="button" onClick={() => void connect(c)}>
                {c.icon ? <img src={c.icon} alt="" /> : null}
                {c.name}
              </button>
            ))
          )}
        </div>
      )}
      {notice && !open ? <div className="wallet-menu" role="status"><p>{notice}</p></div> : null}
    </div>
  );
}
