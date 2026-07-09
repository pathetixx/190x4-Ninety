// Ninety · theme registry
// Единый источник тем для main, onboarding и settings.

export const DEFAULT_THEME_ID = "kurogane";

export const THEMES = [
  {
    id: "kurogane",
    name: "Kurogane",
    kicker: "NEON · RED",
    accent: "#DE5772",
    glow: "rgba(192,48,74,0.35)",
  },
  {
    id: "shiro",
    name: "Shiro Light",
    kicker: "LIGHT · PREMIUM",
    accent: "#D76478",
    glow: "rgba(185,54,78,0.24)",
  },
  {
    id: "sakura",
    name: "Sakura Haze",
    kicker: "SOFT · ROSE",
    accent: "#EA83A2",
    glow: "rgba(196,80,114,0.24)",
  },
  {
    id: "cyan",
    name: "Cyan",
    kicker: "SECURED · CYAN",
    accent: "#6CF2F2",
    glow: "rgba(31,214,214,0.45)",
  },
  {
    id: "glacier",
    name: "Glacier",
    kicker: "ICE · STEEL",
    accent: "#B9F4FF",
    glow: "rgba(118,230,255,0.34)",
  },
  {
    id: "midnight",
    name: "Midnight Indigo",
    kicker: "MIDNIGHT · INDIGO",
    accent: "#B8C6FF",
    glow: "rgba(126,150,255,0.34)",
  },
  {
    id: "synthwave",
    name: "Synthwave",
    kicker: "VIOLET WAVE",
    accent: "#E0A6FF",
    glow: "rgba(199,125,255,0.35)",
  },
  {
    id: "ronin",
    name: "Ronin Violet",
    kicker: "NOIR · VIOLET",
    accent: "#D2AEFF",
    glow: "rgba(166,108,255,0.32)",
  },
  {
    id: "matrix",
    name: "Matrix",
    kicker: "EMERALD",
    accent: "#5CEE92",
    glow: "rgba(43,214,106,0.35)",
  },
  {
    id: "amber",
    name: "Amber Glass",
    kicker: "BLACK · GOLD",
    accent: "#FFD07A",
    glow: "rgba(224,167,80,0.30)",
  },
  {
    id: "mono",
    name: "Mono",
    kicker: "MONOCHROME",
    accent: "#FFFFFF",
    glow: "rgba(255,255,255,0.25)",
  },
  {
    id: "command",
    name: "Command Center",
    kicker: "CMD · CRIMSON",
    accent: "#FF3355",
    glow: "rgba(255,45,70,0.45)",
  },
];

export function themeIds() {
  return THEMES.map(t => t.id);
}

export function isThemeId(id) {
  return THEMES.some(t => t.id === id);
}

export function getThemeMeta(id) {
  return THEMES.find(t => t.id === id) || THEMES.find(t => t.id === DEFAULT_THEME_ID);
}
