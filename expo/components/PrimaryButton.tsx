import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";
import { theme } from "@/constants/theme";

type Props = {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  variant?: "primary" | "ghost" | "outline";
  style?: ViewStyle;
};

export default function PrimaryButton({
  label,
  onPress,
  loading,
  disabled,
  icon,
  variant = "primary",
  style,
}: Props) {
  const handlePress = () => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    onPress();
  };

  if (variant === "primary") {
    return (
      <Pressable
        onPress={handlePress}
        disabled={disabled || loading}
        style={({ pressed }) => [
          styles.wrap,
          { opacity: disabled ? 0.45 : pressed ? 0.92 : 1 },
          style,
        ]}
      >
        <LinearGradient
          colors={["#3B9EFF", "#0A84FF", "#0055CC"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.gradient}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <View style={styles.row}>
              {icon}
              <Text style={styles.label}>{label}</Text>
            </View>
          )}
        </LinearGradient>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.wrap,
        variant === "outline" ? styles.outline : styles.ghost,
        { opacity: disabled ? 0.45 : pressed ? 0.85 : 1 },
        style,
      ]}
    >
      <View style={[styles.row, styles.inner]}>
        {loading ? (
          <ActivityIndicator color={theme.text} />
        ) : (
          <>
            {icon}
            <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: 14,
    overflow: "hidden",
  },
  gradient: {
    paddingVertical: 15,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  inner: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  outline: {
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.bgElevated,
  },
  ghost: {
    backgroundColor: theme.card,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  label: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700" as const,
    letterSpacing: 0.2,
  },
});
