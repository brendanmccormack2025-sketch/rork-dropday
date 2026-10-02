import { Redirect } from "expo-router";

// DMs and groups are retired. Old links go to the feed. The original screen is kept in expo/legacy/.
export default function RetiredRoute() {
  return <Redirect href="/(tabs)" />;
}
