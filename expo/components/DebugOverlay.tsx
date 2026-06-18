import React, { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDebugLogs, type LogEntry } from "@/hooks/useDebugLogs";
import { theme } from "@/constants/theme";

const LEVEL_COLOR: Record<LogEntry["level"], string> = {
  log: "#CCCCCC",
  warn: "#FFD60A",
  error: "#FF453A",
};

const PREFIXES = ["[edit]", "[auth:event]", "[createPost]"];

function LogLine({ entry }: { entry: LogEntry }) {
  const highlight = PREFIXES.some((p) => entry.message.includes(p));
  return (
    <Text
      style={[
        styles.logLine,
        { color: LEVEL_COLOR[entry.level] },
        highlight && styles.highlight,
      ]}
      numberOfLines={3}
    >
      <Text style={styles.ts}>{entry.ts}</Text> {entry.message}
    </Text>
  );
}

export function DebugOverlay() {
  const { entries, clear } = useDebugLogs();
  const [expanded, setExpanded] = useState(true);
  const insets = useSafeAreaInsets();
  const scrollRef = React.useRef<ScrollView>(null);

  const displayed = entries.slice(-30);

  if (!expanded) {
    return (
      <TouchableOpacity
        style={[styles.toggleBtn, { top: insets.top + 8, right: 8 }]}
        onPress={() => setExpanded(true)}
        activeOpacity={0.7}
      >
        <Text style={styles.toggleText}>LOG</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View
      style={[styles.container, { paddingBottom: Math.max(insets.bottom, 8) }]}
      pointerEvents="box-none"
    >
      <View style={styles.header}>
        <Text style={styles.headerText}>DEBUG LOGS</Text>
        <View style={styles.headerRight}>
          <TouchableOpacity onPress={clear} activeOpacity={0.7}>
            <Text style={styles.headerBtn}>CLR</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setExpanded(false)}
            activeOpacity={0.7}
          >
            <Text style={styles.headerBtn}>_</Text>
          </TouchableOpacity>
        </View>
      </View>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollInner}
        onContentSizeChange={() =>
          scrollRef.current?.scrollToEnd({ animated: false })
        }
      >
        {displayed.length === 0 ? (
          <Text style={styles.empty}>Waiting for logs...</Text>
        ) : (
          displayed.map((entry, i) => (
            <LogLine key={i} entry={entry} />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: 280,
    backgroundColor: "rgba(0, 0, 0, 0.92)",
    borderTopWidth: 1,
    borderTopColor: "#1C1C1E",
    zIndex: 99999,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  headerText: {
    color: "#0A84FF",
    fontSize: 10,
    fontFamily: "SpaceMono",
    fontWeight: "700",
    letterSpacing: 1,
  },
  headerRight: {
    flexDirection: "row",
    gap: 12,
  },
  headerBtn: {
    color: "#999",
    fontSize: 11,
    fontFamily: "SpaceMono",
    fontWeight: "700",
  },
  scroll: {
    flex: 1,
  },
  scrollInner: {
    paddingHorizontal: 6,
    paddingBottom: 4,
  },
  logLine: {
    fontSize: 9,
    fontFamily: "SpaceMono",
    lineHeight: 13,
    paddingVertical: 1,
  },
  ts: {
    color: "#555",
  },
  highlight: {
    color: "#0A84FF",
  },
  empty: {
    color: "#555",
    fontSize: 9,
    fontFamily: "SpaceMono",
    fontStyle: "italic",
    padding: 8,
  },
  toggleBtn: {
    position: "absolute",
    zIndex: 99999,
    backgroundColor: "rgba(0,0,0,0.85)",
    borderWidth: 1,
    borderColor: "#0A84FF",
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  toggleText: {
    color: "#0A84FF",
    fontSize: 10,
    fontFamily: "SpaceMono",
    fontWeight: "700",
  },
});
