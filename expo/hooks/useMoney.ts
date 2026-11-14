import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/providers/AuthProvider";
import { fetchMyFeatures, NO_FEATURES, type MyFeatures } from "@/lib/moneyFeatures";
import { fetchMoneyProfile, type MoneyProfile } from "@/lib/moneyApi";

export type MoneyState = {
  features: MyFeatures;
  profile: MoneyProfile | null;
  /** The server's answer is in (until then the tab stays hidden). */
  loaded: boolean;
  refresh: () => Promise<void>;
};

/**
 * Whether Money exists for this person at all, and where they are in it. The database decides (my_features / my_money_profile); nothing
 * here is a client-side gate. The tab is hidden unless features.money is true, which needs the 'money' flag on for them, a profile, no
 * ban or sanction, and not a known minor.
 */
export function useMoney(): MoneyState {
  const { user } = useAuth();
  const qc = useQueryClient();
  const features = useQuery({ queryKey: ["money", "features", user?.id], enabled: !!user?.id, staleTime: 60_000, queryFn: fetchMyFeatures });
  const profile = useQuery({
    queryKey: ["money", "profile", user?.id],
    enabled: !!user?.id && features.data?.money === true,
    staleTime: 30_000,
    queryFn: fetchMoneyProfile,
  });
  return {
    features: features.data ?? NO_FEATURES,
    profile: profile.data ?? null,
    loaded: features.isFetched,
    refresh: async () => { await qc.invalidateQueries({ queryKey: ["money"] }); },
  };
}
