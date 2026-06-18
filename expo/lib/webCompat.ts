/**
 * Web compatibility layer — strips `collapsable` from React elements before
 * they reach the DOM.  React 19 rejects boolean values on non-boolean HTML
 * attributes, and several React Native libraries pass `collapsable={false}`
 * through to DOM elements on web.
 *
 * Patches both the JSX runtime (for JSX-transformed code) and
 * `React.createElement` (for imperative code paths like
 * react-native-web's `createAnimatedComponent` and `ScrollView`).
 *
 * Must be imported BEFORE any rendering happens. Import it at the top of
 * `_layout.tsx`.
 */

import React from "react";
import { Platform } from "react-native";

type Props = Record<string, unknown> | null | undefined;

function stripCollapsable(props: Props): Props {
  if (props && "collapsable" in props) {
    const { collapsable: _, ...rest } = props;
    return rest;
  }
  return props;
}

if (Platform.OS === "web") {
  // ── 1. Patch React.createElement (imperative code paths) ──────────
  const origCreateElement = React.createElement.bind(
    React,
  ) as typeof React.createElement;

  React.createElement = function patchedCreateElement(
    type: any,
    props: any,
    ...children: any[]
  ) {
    return origCreateElement(type, stripCollapsable(props), ...children);
  } as any;

  // ── 2. Patch JSX runtime (JSX transform code paths) ───────────────
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jsxRuntime = require("react/jsx-runtime") as {
      jsx: (...args: any[]) => any;
      jsxs: (...args: any[]) => any;
      jsxDEV: (...args: any[]) => any;
    };

    const wrap =
      (fn: (...args: any[]) => any) =>
      (...args: any[]) => {
        const intercepted = [...args];
        if (
          intercepted.length > 1 &&
          intercepted[1] &&
          typeof intercepted[1] === "object"
        ) {
          intercepted[1] = stripCollapsable(
            intercepted[1] as Record<string, unknown>,
          );
        }
        return fn(...intercepted);
      };

    if (jsxRuntime.jsx) jsxRuntime.jsx = wrap(jsxRuntime.jsx);
    if (jsxRuntime.jsxs) jsxRuntime.jsxs = wrap(jsxRuntime.jsxs);
    if (jsxRuntime.jsxDEV) jsxRuntime.jsxDEV = wrap(jsxRuntime.jsxDEV);
  } catch {
    // JSX runtime not available — non-JSX environment, skip
  }
}
