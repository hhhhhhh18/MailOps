import type { Config } from "tailwindcss";

/**
 * Dark-first design system.
 *
 * Colour is reserved for status communication (product spec #33): green means an
 * offer, blue is informational, yellow is waiting, red is rejected/critical, gray
 * is neutral. Everything structural is a neutral surface so status colour always
 * reads as signal rather than decoration.
 */
const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Neutral surfaces — used for every structural element.
        surface: {
          base: "#0b0d10",
          raised: "#12151a",
          overlay: "#181c22",
          border: "#242a33",
          hover: "#1c2129",
        },
        content: {
          primary: "#e8eaed",
          secondary: "#9aa4b2",
          muted: "#6b7480",
          inverse: "#0b0d10",
        },
        // Status palette. Each has a text and a subtle background variant.
        status: {
          success: "#34d399",
          "success-bg": "rgba(52, 211, 153, 0.12)",
          info: "#60a5fa",
          "info-bg": "rgba(96, 165, 250, 0.12)",
          waiting: "#fbbf24",
          "waiting-bg": "rgba(251, 191, 36, 0.12)",
          critical: "#f87171",
          "critical-bg": "rgba(248, 113, 113, 0.12)",
          neutral: "#9aa4b2",
          "neutral-bg": "rgba(154, 164, 178, 0.12)",
          accent: "#818cf8",
          "accent-bg": "rgba(129, 140, 248, 0.12)",
        },
      },
      borderRadius: {
        card: "0.75rem",
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        // Dense, information-first scale.
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        card: "0 1px 2px rgba(0, 0, 0, 0.4)",
        popover: "0 10px 30px rgba(0, 0, 0, 0.45)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(2px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 120ms ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
