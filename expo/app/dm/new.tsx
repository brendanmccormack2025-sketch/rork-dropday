import { Redirect } from "expo-router";

// The old DMs are retired; messaging between friends lives in /messages now. Old links (and old notifications) go there.
// Old conversation ids do not map to the new conversations, so every old route opens the Messages list.
// The original screen is kept in expo/legacy/.
export default function RetiredRoute() {
  return <Redirect href={"/messages" as never} />;
}
