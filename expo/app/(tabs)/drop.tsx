import { Redirect } from "expo-router";
import React from "react";

/**
 * Tab entry is replaced by a custom center button that routes to /camera
 * as a fullscreen modal. This redirect handles direct navigation to /drop.
 */
export default function DropTabRedirect() {
  return <Redirect href="/camera" />;
}
