import React, { forwardRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Eye, EyeOff } from "lucide-react-native";

import UiText from "@/components/UiText";
import { theme } from "@/constants/theme";

type Props = React.ComponentProps<typeof TextInput> & { label: string };

/** A rounded input for the sign-in / create-account screens: the border turns red while typing; passwords can be shown. */
const AuthField = forwardRef<TextInput, Props>(function AuthField({ label, style, secureTextEntry, onFocus, onBlur, ...rest }, ref) {
  const [focused, setFocused] = useState(false);
  const [shown, setShown] = useState(false);
  return (
    <View style={styles.wrap}>
      <UiText weight={700} style={styles.label}>
        {label}
      </UiText>
      <View style={[styles.box, focused && styles.boxFocused]}>
        <TextInput
          ref={ref}
          {...rest}
          secureTextEntry={secureTextEntry && !shown}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          placeholderTextColor={theme.textDim}
          style={[styles.input, style]}
        />
        {secureTextEntry ? (
          <Pressable onPress={() => setShown((v) => !v)} hitSlop={10} style={styles.eye} accessibilityLabel={shown ? "Hide password" : "Show password"}>
            {shown ? <EyeOff size={20} color={theme.textMuted} /> : <Eye size={20} color={theme.textMuted} />}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
});

export default AuthField;

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  label: { color: theme.text, fontSize: 14 },
  box: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.card,
    borderWidth: 1.5,
    borderColor: theme.border,
    borderRadius: 16,
    minHeight: 56,
  },
  boxFocused: { borderColor: theme.accent },
  input: { flex: 1, paddingHorizontal: 16, paddingVertical: 15, color: theme.text, fontSize: 16, fontFamily: "PlusJakartaSans_500Medium" },
  eye: { paddingHorizontal: 14, height: 56, justifyContent: "center" },
});
