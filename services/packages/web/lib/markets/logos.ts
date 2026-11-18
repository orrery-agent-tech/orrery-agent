/**
 * Official logos of the Robinhood stock tokens on Robinhood Chain (4663), keyed by token address. Owner rule: every
 * listed stock shows its company's real mark; a market whose token has no entry here is not listed (no ticker placeholder).
 * Files: public/stocks/<address>.png, 256x256, trimmed and padded. Sources: lib/markets/logo-sources.md.
 * Token addresses and feeds: the 36 stock tokens with a Chainlink feed on 4663, as read on chain 2026-10-31.
 */
export interface StockLogo {
  symbol: string;
  issuer: string;
  /** Site-relative file; empty for a hidden stock. */
  src: string;
  /** Set when the owner has hidden the stock (no usable logo licence yet); the market is not listed. */
  hidden?: string;
}

export const STOCK_LOGOS_4663: Record<string, StockLogo> = {
  "0x941ae714ec6d8130c7b75d67160ca08f1e7d11dd": { symbol: "DELL", issuer: "Dell Technologies (DELL)", src: "/stocks/0x941ae714ec6d8130c7b75d67160ca08f1e7d11dd.png" },
  "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea": { symbol: "SPCX", issuer: "Space Exploration Technologies (SpaceX)", src: "/stocks/0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea.png" },
  "0x117cc2133c37b721f49de2a7a74833232b3b4c0c": { symbol: "SPY", issuer: "SPDR S&P 500 ETF Trust (SPY), State Street", src: "/stocks/0x117cc2133c37b721f49de2a7a74833232b3b4c0c.png" },
  "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e": { symbol: "GLD", issuer: "SPDR Gold Trust (GLD), State Street", src: "/stocks/0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e.png" },
  "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68": { symbol: "QQQ", issuer: "Invesco QQQ Trust (QQQ), Invesco", src: "/stocks/0xd5f3879160bc7c32ebb4dc785f8a4f505888de68.png" },
  "0x58ffe4a942d3885baa22d7520691f611ef09e7aa": { symbol: "TSM", issuer: "Taiwan Semiconductor Manufacturing (TSM)", src: "/stocks/0x58ffe4a942d3885baa22d7520691f611ef09e7aa.png" },
  "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681": { symbol: "INTC", issuer: "Intel Corporation (INTC)", src: "/stocks/0xc72b96e0e48ecd4dc75e1e45396e26300bc39681.png" },
  "0xe93237c50d904957cf27e7b1133b510c669c2e74": { symbol: "MSFT", issuer: "Microsoft Corporation (MSFT)", src: "/stocks/0xe93237c50d904957cf27e7b1133b510c669c2e74.png" },
  "0x284358abc07f9359f19f4b5b4ac91901be2597ba": { symbol: "RGTI", issuer: "Rigetti Computing (RGTI)", src: "/stocks/0x284358abc07f9359f19f4b5b4ac91901be2597ba.png" },
  "0xc0d6457c16cc70d6790dd43521c899c87ce02f35": { symbol: "META", issuer: "Meta Platforms (META)", src: "/stocks/0xc0d6457c16cc70d6790dd43521c899c87ce02f35.png" },
  "0xb90a19ff0af67f7779aff50a882a9cff42446400": { symbol: "SNDK", issuer: "Sandisk Corporation (SNDK)", src: "/stocks/0xb90a19ff0af67f7779aff50a882a9cff42446400.png" },
  "0x12f190a9f9d7d37a250758b26824b97ce941bf54": { symbol: "AMZN", issuer: "Amazon.com, Inc. (AMZN)", src: "/stocks/0x12f190a9f9d7d37a250758b26824b97ce941bf54.png" },
  "0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5": { symbol: "CRCL", issuer: "Circle Internet Group (CRCL)", src: "", hidden: "Circle's Brand Use Policy permits no commercial use of its brand assets; hidden until Circle gives permission (owner, 2026-11-08)" },
  "0xd917b029c761d264c6a312bbbcda868658ef86a6": { symbol: "USAR", issuer: "USA Rare Earth (USAR)", src: "/stocks/0xd917b029c761d264c6a312bbbcda868658ef86a6.png" },
  "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3": { symbol: "GOOGL", issuer: "Alphabet Inc. (GOOGL)", src: "/stocks/0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3.png" },
  "0x92fd66527192e3e61d4ddd13322aa222de86f9b5": { symbol: "SGOV", issuer: "iShares 0-3 Month Treasury Bond ETF (SGOV), iShares by BlackRock", src: "/stocks/0x92fd66527192e3e61d4ddd13322aa222de86f9b5.png" },
  "0xad25ac6c84d497db898fa1e8387bf6af3532a1c4": { symbol: "BABA", issuer: "Alibaba Group (BABA)", src: "", hidden: "Alibaba's media library allows its logos for editorial use by accredited media only; hidden until Alibaba gives permission (owner, 2026-11-08)" },
  "0xcbb95bbf36099d34da091dc6fa6f49efa257cee3": { symbol: "CLSK", issuer: "CleanSpark, Inc. (CLSK)", src: "/stocks/0xcbb95bbf36099d34da091dc6fa6f49efa257cee3.png" },
  "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a": { symbol: "PLTR", issuer: "Palantir Technologies (PLTR)", src: "/stocks/0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a.png" },
  "0xff080c8ce2e5feadaca0da81314ae59d232d4afd": { symbol: "MU", issuer: "Micron Technology (MU)", src: "/stocks/0xff080c8ce2e5feadaca0da81314ae59d232d4afd.png" },
  "0x3b14c39e89d60d627b42a1a4ca45b5bb45fc12e2": { symbol: "RKLB", issuer: "Rocket Lab (RKLB)", src: "/stocks/0x3b14c39e89d60d627b42a1a4ca45b5bb45fc12e2.png" },
  "0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3": { symbol: "CRWV", issuer: "CoreWeave, Inc. (CRWV)", src: "/stocks/0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3.png" },
  "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc": { symbol: "AMD", issuer: "Advanced Micro Devices (AMD)", src: "/stocks/0x86923f96303d656e4aa86d9d42d1e57ad2023fdc.png" },
  "0x7f0abef0c07280f82c6a08ead09ded6bae2c13fc": { symbol: "EWY", issuer: "iShares MSCI South Korea ETF (EWY), iShares by BlackRock", src: "/stocks/0x7f0abef0c07280f82c6a08ead09ded6bae2c13fc.png" },
  "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec": { symbol: "NVDA", issuer: "NVIDIA Corporation (NVDA)", src: "/stocks/0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec.png" },
  "0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344": { symbol: "USO", issuer: "United States Oil Fund (USO), USCF Investments", src: "/stocks/0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344.png" },
  "0x6330d8c3178a418788df01a47479c0ce7ccf450b": { symbol: "COIN", issuer: "Coinbase Global (COIN)", src: "/stocks/0x6330d8c3178a418788df01a47479c0ce7ccf450b.png" },
  "0x9d9c6684f596f66a64c030b93a886d51fd4d7931": { symbol: "NBIS", issuer: "Nebius Group (NBIS)", src: "/stocks/0x9d9c6684f596f66a64c030b93a886d51fd4d7931.png" },
  "0x558378e000d634a36593e338ebacdd6207640efe": { symbol: "IONQ", issuer: "IonQ, Inc. (IONQ)", src: "/stocks/0x558378e000d634a36593e338ebacdd6207640efe.png" },
  "0xb0992820e760d836549ba69bc7598b4af75dee03": { symbol: "ORCL", issuer: "Oracle Corporation (ORCL)", src: "/stocks/0xb0992820e760d836549ba69bc7598b4af75dee03.png" },
  "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9": { symbol: "AAPL", issuer: "Apple Inc. (AAPL)", src: "/stocks/0xaf3d76f1834a1d425780943c99ea8a608f8a93f9.png" },
  "0x1b0e319c6a659f002271b69db8a7df2f911c153e": { symbol: "GME", issuer: "GameStop Corp. (GME)", src: "/stocks/0x1b0e319c6a659f002271b69db8a7df2f911c153e.png" },
  "0xec262a75e413fafd0df80480274532c79d42da09": { symbol: "MSTR", issuer: "Strategy Inc. (MSTR, formerly MicroStrategy)", src: "/stocks/0xec262a75e413fafd0df80480274532c79d42da09.png" },
  "0x322f0929c4625ed5bad873c95208d54e1c003b2d": { symbol: "TSLA", issuer: "Tesla, Inc. (TSLA)", src: "/stocks/0x322f0929c4625ed5bad873c95208d54e1c003b2d.png" },
  "0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f": { symbol: "SLV", issuer: "iShares Silver Trust (SLV), iShares by BlackRock", src: "/stocks/0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f.png" },
  "0x47f93d52cbec7c6d2cfc080e154002370a60daea": { symbol: "ASML", issuer: "ASML Holding N.V. (ASML)", src: "/stocks/0x47f93d52cbec7c6d2cfc080e154002370a60daea.png" },
};

/** The same marks by symbol, for development networks whose test tokens copy the 4663 stocks under other addresses. */
export const STOCK_LOGOS_BY_SYMBOL: Record<string, StockLogo> = Object.fromEntries(Object.values(STOCK_LOGOS_4663).map((l) => [l.symbol, l]));

/**
 * The official mark of a stock token: on Robinhood Chain by token address only; on a development network (46630, local)
 * by address, then by symbol, since its test tokens copy the 4663 stocks under other addresses. Undefined means the
 * market is not listed.
 */
export function stockLogo(chainId: number, address: string, symbol: string): StockLogo | undefined {
  const byAddress = STOCK_LOGOS_4663[address.toLowerCase()];
  const logo = chainId === 4663 ? byAddress : (byAddress ?? STOCK_LOGOS_BY_SYMBOL[symbol.toUpperCase()]);
  // A hidden stock has no usable logo yet, so it is not listed either.
  return logo && !logo.hidden ? logo : undefined;
}
