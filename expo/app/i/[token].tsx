import { Redirect, useLocalSearchParams } from "expo-router";

/** The web link (https://…/i/<token>), once the app owns it (universal links, next build), goes to the same place as the app link. */
export default function WebInviteRedirect() {
  const { token } = useLocalSearchParams<{ token: string }>();
  return <Redirect href={`/invite/${String(token)}` as never} />;
}
