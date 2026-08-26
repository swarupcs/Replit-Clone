import { theme } from "antd";
import type { ThemeConfig } from "antd";
import type { ThemeMode } from "../store/themeStore.ts";

/** Antd theme derived from the CSS tokens in `index.css`.
 *
 *  Antd computes its own palettes from seeds at runtime, so it can't read the
 *  CSS custom properties directly -- the literals here must stay in step with
 *  that file. Everything the app renders (Card, Modal, Input, List, Segmented,
 *  Alert, Spin...) picks up its look from this one object, which is why the
 *  pages themselves carry so little styling.
 */
/** The dark theme, and the values the light one differs by.
 *
 *  Antd computes its palettes from seeds at runtime, so it cannot read the CSS
 *  custom properties in `index.css` — the literals here must stay in step with
 *  that file, in both blocks.
 */
const dark: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: "#8b5cf6",
    colorInfo: "#60a5fa",
    colorSuccess: "#4ade80",
    colorWarning: "#fbbf24",
    colorError: "#f87171",

    colorBgBase: "#08090f",
    colorBgContainer: "#14161f",
    colorBgElevated: "#191b26",
    colorBgLayout: "#0d0e16",
    colorBorder: "#232634",
    colorBorderSecondary: "#1c1f2b",

    colorText: "#f2f3f7",
    colorTextSecondary: "#a2a7bd",
    colorTextTertiary: "#6b7192",
    colorTextQuaternary: "#565b78",

    fontFamily: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
    fontFamilyCode:
      '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, monospace',
    fontSize: 14,

    borderRadius: 10,
    borderRadiusLG: 14,
    borderRadiusSM: 6,

    controlHeight: 38,
    lineWidth: 1,
    wireframe: false,

    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.45)",
    boxShadowSecondary: "0 16px 48px rgba(0, 0, 0, 0.55)",
  },
  components: {
    Button: {
      fontWeight: 500,
      primaryShadow: "0 4px 14px rgba(139, 92, 246, 0.3)",
      defaultBg: "#191b26",
      defaultBorderColor: "#2b2f3f",
    },
    Card: {
      colorBgContainer: "#12141d",
      headerBg: "transparent",
      paddingLG: 24,
    },
    Input: {
      colorBgContainer: "#0f111a",
      activeShadow: "0 0 0 3px rgba(139, 92, 246, 0.16)",
      paddingBlock: 8,
    },
    Modal: {
      contentBg: "#12141d",
      headerBg: "#12141d",
      titleFontSize: 18,
    },
    Segmented: {
      trackBg: "#0f111a",
      itemSelectedBg: "#272b3b",
      itemSelectedColor: "#f2f3f7",
      trackPadding: 4,
      borderRadius: 8,
    },
    List: {
      colorBorder: "#232634",
    },
    Alert: {
      borderRadiusLG: 10,
    },
    Tooltip: {
      colorBgSpotlight: "#191b26",
      colorTextLightSolid: "#f2f3f7",
    },
    Message: {
      contentBg: "#191b26",
    },
  },
};

/** Light. Only what differs: everything structural — radii, control height,
 *  fonts, the wireframe decision — is shared, because those are the design
 *  system and not the palette. */
const light: ThemeConfig = {
  ...dark,
  algorithm: theme.defaultAlgorithm,
  token: {
    ...dark.token,
    // Darker than the dark theme's violet: #8b5cf6 on white does not carry
    // enough contrast for text, and antd uses the primary colour for both.
    colorPrimary: "#6d28d9",
    colorInfo: "#2563eb",
    colorSuccess: "#15803d",
    colorWarning: "#b45309",
    colorError: "#dc2626",

    colorBgBase: "#f4f6fb",
    colorBgContainer: "#ffffff",
    colorBgElevated: "#ffffff",
    colorBgLayout: "#eef1f8",
    colorBorder: "#dbe0ec",
    colorBorderSecondary: "#e6eaf3",

    colorText: "#131623",
    colorTextSecondary: "#4a5169",
    colorTextTertiary: "#6f778f",
    colorTextQuaternary: "#8a91a8",

    boxShadow: "0 4px 16px rgba(19, 22, 35, 0.1)",
    boxShadowSecondary: "0 16px 48px rgba(19, 22, 35, 0.14)",
  },
  components: {
    ...dark.components,
    Button: {
      fontWeight: 500,
      primaryShadow: "0 4px 14px rgba(109, 40, 217, 0.22)",
      defaultBg: "#ffffff",
      defaultBorderColor: "#cbd2e2",
    },
    Card: { colorBgContainer: "#ffffff", headerBg: "transparent", paddingLG: 24 },
    Input: {
      colorBgContainer: "#ffffff",
      activeShadow: "0 0 0 3px rgba(109, 40, 217, 0.14)",
      paddingBlock: 8,
    },
    Modal: { contentBg: "#ffffff", headerBg: "#ffffff", titleFontSize: 18 },
    Segmented: {
      trackBg: "#e6eaf3",
      itemSelectedBg: "#ffffff",
      itemSelectedColor: "#131623",
      trackPadding: 4,
      borderRadius: 8,
    },
    List: { colorBorder: "#dbe0ec" },
    Alert: { borderRadiusLG: 10 },
    Tooltip: { colorBgSpotlight: "#131623", colorTextLightSolid: "#ffffff" },
    Message: { contentBg: "#ffffff" },
  },
};

export function antdThemeFor(mode: ThemeMode): ThemeConfig {
  return mode === "light" ? light : dark;
}
