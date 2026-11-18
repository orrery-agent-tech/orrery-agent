"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type {
  CommunityAchievement,
  CommunityMessage,
  CommunityRecipient,
  CommunityRewardEvent,
  CommunityRoom,
  CommunityTemplate,
  MostActiveResponse,
  ReferralSummary,
} from "@orrery/shared";
import { API_URL } from "../config";
import { get } from "../orry/api";

/**
 * Reads from the community API (lane L1). Amounts stay decimal strings in base units as the API sends them; the views turn
 * them into bigints where they are shown. A held feature's route answers 404, so each read runs only while its page is open.
 */

const PAGE = 50;
const on = (open: boolean, ...also: unknown[]) => Boolean(API_URL && open && also.every(Boolean));
const live = { refetchInterval: 15_000, retry: 1 } as const;

export const useRooms = (open: boolean) =>
  useQuery({ queryKey: ["community", "rooms"], queryFn: () => get<{ rooms: CommunityRoom[] }>("/v1/community/rooms"), enabled: on(open), refetchInterval: 60_000, retry: 1 });

/** Messages of one room, newest first, 50 a page; earlier pages load with `before`. */
export const useMessages = (room: number, open: boolean) =>
  useInfiniteQuery({
    queryKey: ["community", "messages", room],
    queryFn: ({ pageParam }) => get<{ messages: CommunityMessage[] }>(`/v1/community/messages?room=${room}&limit=${PAGE}${pageParam ? `&before=${pageParam}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => (last.messages.length < PAGE ? undefined : last.messages[last.messages.length - 1]?.id),
    enabled: on(open),
    refetchInterval: 10_000,
    retry: 1,
  });

export interface RewardsResponse {
  pool: { asset: string; free: string; locked: string }[];
  events: CommunityRewardEvent[];
  achievements: CommunityAchievement[];
}
export const useRewards = (open: boolean) => useQuery({ queryKey: ["community", "rewards"], queryFn: () => get<RewardsResponse>("/v1/community/rewards"), enabled: on(open), ...live });

export const useRecipients = (id: number, open: boolean) =>
  useQuery({
    queryKey: ["community", "recipients", id],
    queryFn: () => get<{ recipients: CommunityRecipient[] }>(`/v1/community/achievements/${id}/recipients`),
    enabled: on(open),
    ...live,
  });

export const useMostActive = (open: boolean) =>
  useQuery({ queryKey: ["community", "most-active", 7], queryFn: () => get<MostActiveResponse>("/v1/community/most-active?days=7"), enabled: on(open), refetchInterval: 60_000, retry: 1 });

export const useTemplates = (open: boolean) =>
  useQuery({ queryKey: ["community", "templates"], queryFn: () => get<{ templates: CommunityTemplate[] }>("/v1/community/templates"), enabled: on(open), ...live });

export const useReferral = (address: Address | undefined, open: boolean) =>
  useQuery({ queryKey: ["community", "referral", address?.toLowerCase()], queryFn: () => get<ReferralSummary>(`/v1/community/referrals/${address}`), enabled: on(open, address), ...live });

export interface ReferralBoardRow {
  rank: number;
  address: string;
  referees: number;
  volumeUsd: string;
  tier: string | null;
}
export const useReferralBoard = (open: boolean) =>
  useQuery({ queryKey: ["community", "referral-board"], queryFn: () => get<{ rows: ReferralBoardRow[] }>("/v1/community/referrals/leaderboard"), enabled: on(open), refetchInterval: 60_000, retry: 1 });

export interface CashbackResponse {
  months: ReferralSummary["months"];
  records: { feeUsd: string; rewardUsd: string; feePaidAt: string; kind: number }[];
}
export const useCashback = (address: Address | undefined, open: boolean) =>
  useQuery({ queryKey: ["community", "cashback", address?.toLowerCase()], queryFn: () => get<CashbackResponse>(`/v1/community/cashback/${address}`), enabled: on(open, address), ...live });
