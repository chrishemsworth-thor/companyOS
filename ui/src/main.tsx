import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { watchSystemTheme } from "./lib/theme";
import "./styles.css";

// index.html stamped the initial theme pre-paint; from here on, track OS
// appearance changes while the preference is "system".
watchSystemTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
