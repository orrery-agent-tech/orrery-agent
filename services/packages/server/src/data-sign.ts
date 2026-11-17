import { getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertDataValues,
  dataDomain,
  dataQueryHash,
  dataRecordsHash,
  dataResponseTypes,
  normalizeDataQuery,
  type DataRecord,
  type DataResponse,
  type DatasetId,
} from "@orrery/shared";
import type { Config } from "./config.js";

/** The data signer's address (R-52), published at `GET /v1/data/signer`. */
export const dataSignerAddress = (cfg: Config): Address => getAddress(privateKeyToAccount(cfg.data!.signerKey).address);

/**
 * Signs one data response (D-10). Records must be canonical (strings, safe integers, booleans, null), so the hash any
 * client recomputes from the served JSON is the one signed here.
 */
export async function signDataResponse(
  cfg: Config,
  args: { dataset: DatasetId; view: string; query: Record<string, unknown>; records: DataRecord[]; asOfBlock: bigint; next: string | null },
): Promise<DataResponse> {
  assertDataValues(args.records);
  const query = normalizeDataQuery({ ...args.query, view: args.view });
  const queryHash = dataQueryHash(query);
  const recordsHash = dataRecordsHash(args.records);
  const issuedAt = Math.floor(Date.now() / 1000);
  const account = privateKeyToAccount(cfg.data!.signerKey);
  const signature = await account.signTypedData({
    domain: dataDomain(cfg.chainId),
    types: dataResponseTypes,
    primaryType: "DataResponse",
    message: { dataset: args.dataset, queryHash, recordsHash, asOfBlock: args.asOfBlock, issuedAt: BigInt(issuedAt) },
  });
  return {
    dataset: args.dataset,
    view: args.view,
    query,
    asOfBlock: args.asOfBlock.toString(),
    issuedAt,
    records: args.records,
    next: args.next,
    queryHash,
    recordsHash,
    signer: getAddress(account.address),
    signature,
    chainId: cfg.chainId,
  };
}
