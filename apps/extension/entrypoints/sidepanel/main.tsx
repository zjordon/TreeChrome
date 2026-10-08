import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@tw/console-ui/theme.css";
import "./sidepanel.css";
import { App } from "./App";

const rootEl = document.getElementById("root");
if (rootEl !== null) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
