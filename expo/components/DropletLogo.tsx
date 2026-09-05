import React from "react";
import Svg, { Defs, LinearGradient, Path, Stop, RadialGradient, Circle } from "react-native-svg";

type Props = { size?: number };

/** Electric-blue glowing droplet — the DropDay brand mark. */
export default function DropletLogo({ size = 96 }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id="dg" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#4DA6FF" />
          <Stop offset="0.45" stopColor="#0A84FF" />
          <Stop offset="1" stopColor="#0044AA" />
        </LinearGradient>
        <LinearGradient id="dh" x1="0.2" y1="0" x2="0.8" y2="1">
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.55" />
          <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </LinearGradient>
        <RadialGradient id="gl" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor="#0A84FF" stopOpacity="0.25" />
          <Stop offset="0.6" stopColor="#0A84FF" stopOpacity="0.06" />
          <Stop offset="1" stopColor="#0A84FF" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Circle cx="50" cy="50" r="48" fill="url(#gl)" />
      <Path
        d="M50 8 C50 8 90 49 90 70 A40 40 0 1 1 10 70 C10 49 50 8 50 8 Z"
        fill="url(#dg)"
      />
      <Path
        d="M36 32 C28 45 27 57 31 65 C35 52 43 42 50 36 C46 33 40 32 36 32 Z"
        fill="url(#dh)"
      />
    </Svg>
  );
}
