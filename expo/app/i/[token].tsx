import { Redirect, useLocalSearchParams } from "expo-router";

/** The web link (https://tryal.pages.dev/i/<token>, a universal link from 1.0.6) goes to the same place as the app link. */
export default function WebInviteRedirect() {
  const { token } = useLocalSearchParams<{ token: string }>();
  return <Redirect href={`/invite/${String(token)}` as never} />;
}
