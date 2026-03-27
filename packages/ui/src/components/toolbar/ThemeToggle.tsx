import React from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "../../contexts/ThemeContext.js";
import { IconButton } from "./IconButton.js";

const CYCLE: Array<"system" | "light" | "dark"> = ["system", "light", "dark"];
const LABELS: Record<string, string> = {
  system: "Theme: System",
  light: "Theme: Light",
  dark: "Theme: Dark",
};
const ICONS: Record<string, React.ReactNode> = {
  system: <Monitor size={14} />,
  light: <Sun size={14} />,
  dark: <Moon size={14} />,
};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length];

  return (
    <IconButton
      icon={ICONS[theme]}
      title={`${LABELS[theme]} (click → ${next})`}
      onClick={() => setTheme(next)}
    />
  );
}
