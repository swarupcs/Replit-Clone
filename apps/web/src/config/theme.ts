import { theme } from "antd";
import type { ThemeConfig } from "antd";

/** Antd theme derived from the CSS tokens in `index.css`.
 *
 *  Antd computes its own palettes from seeds at runtime, so it can't read the
 *  CSS custom properties directly -- the literals here must stay in step with
 *  that file. Everything the app renders (Card, Modal, Input, List, Segmented,
 *  Alert, Spin...) picks up its look from this one object, which is why the
 *  pages themselves carry so little styling.
 */
export const antdTheme: ThemeConfig = {
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
