import { useEffect } from "react";
import {
  resolveMode,
  useThemeStore,
  type ThemeMode,
} from "../store/themeStore.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

/** The theme currently in force, and the `data-theme` attribute that puts it
 *  on the page.
 *
 *  The attribute is what every CSS token hangs off; antd cannot read those, so
 *  the mode is also returned for the `ConfigProvider`. Both come from one place
 *  so they cannot disagree.
 */
export function useThemeMode(): ThemeMode {
  const choice = useThemeStore((state) => state.choice);
  // Set only by the embed page, from the URL. See the store for why it wins.
  const override = useThemeStore((state) => state.override);
  // Subscribed to, not merely read: "system" has to follow the OS changing
  // while the app is open, which is exactly when someone notices it did not.
  const systemIsLight = useMediaQuery("(prefers-color-scheme: light)");

  const mode: ThemeMode =
    override ??
    (choice === "system"
      ? systemIsLight
        ? "light"
        : "dark"
      : resolveMode(choice));

  useEffect(() => {
    document.documentElement.dataset["theme"] = mode;
  }, [mode]);

  return mode;
}
