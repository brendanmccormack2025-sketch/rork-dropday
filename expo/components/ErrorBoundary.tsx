import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import UiText from "@/components/UiText";
import { StatusBar } from "expo-status-bar";
import { AlertTriangle, RefreshCw } from "lucide-react-native";
import { theme } from "@/constants/theme";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Global error boundary — catches unhandled React render errors
 * and shows a recoverable error screen instead of a black-screen crash.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("[ErrorBoundary] Caught fatal error:", error.message);
    console.error("[ErrorBoundary] Component stack:", errorInfo.componentStack ?? "N/A");
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <StatusBar style="light" />
          <View style={styles.card}>
            <View style={styles.iconWrap}>
              <AlertTriangle color={theme.danger} size={36} strokeWidth={1.5} />
            </View>
            <UiText style={styles.title}>Something went wrong</UiText>
            <UiText style={styles.subtitle}>
              The app encountered an unexpected error. This is likely temporary — tap below to
              recover.
            </UiText>
            {this.state.error && (
              <UiText style={styles.errorDetail} numberOfLines={3}>
                {this.state.error.message}
              </UiText>
            )}
            <Pressable
              onPress={this.handleReset}
              style={styles.resetBtn}
              accessibilityLabel="Restart app"
            >
              <RefreshCw color="#fff" size={16} strokeWidth={2.5} />
              <UiText style={styles.resetBtnText}>Try Again</UiText>
            </Pressable>
          </View>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  card: {
    alignItems: "center",
    gap: 14,
    maxWidth: 320,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 0,
    backgroundColor: "rgba(232,41,28,0.12)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  title: {
    color: theme.text,
    fontSize: 20,
    fontWeight: "900" as const,
    textAlign: "center",
  },
  subtitle: {
    color: theme.textMuted,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  errorDetail: {
    color: theme.danger,
    fontSize: 11,
    fontWeight: "500" as const,
    textAlign: "center",
    backgroundColor: "rgba(232,41,28,0.08)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 0,
    overflow: "hidden",
    maxWidth: "100%",
  },
  resetBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 22,
    paddingVertical: 13,
    borderRadius: 0,
    backgroundColor: theme.accent,
    marginTop: 8,
    shadowColor: theme.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
  },
  resetBtnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700" as const,
  },
});
