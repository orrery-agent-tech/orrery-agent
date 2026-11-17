"use client";

import { use } from "react";
import { isAddress } from "viem";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { PageHead } from "@/components/PageHead";
import { Record } from "@/components/Record";
import { deployed } from "@/lib/config";
import { useSignerView } from "@/lib/lens";

export default function SignerPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const { data, isLoading, error } = useSignerView(address);
  return (
    <div className="product-page circuit">
      <Nav />
      <main className="signer-main">
        <PageHead kicker="Signer reading" title={address} titleClass="mono" art="signer-lookup" />
        {!isAddress(address) ? <div className="panel"><h2>This is not a valid address</h2><p>Look over the characters and paste it again.</p></div>
          : !deployed ? <div className="panel"><h2>Readings start soon</h2><p>Signer readings show here as soon as the contracts go live on this network.</p></div>
          : isLoading ? <div className="panel"><h2>Reading chain state</h2></div>
          : error || !data ? <div className="panel"><h2>Reading incomplete</h2><p>Reload the page in a moment.</p></div>
          : <Record view={data} />}
      </main>
      <Footer />
    </div>
  );
}
