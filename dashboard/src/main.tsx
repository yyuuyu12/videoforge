import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./progress-rail.css";
import "./works-covers.css";
import "./douyin-extractions.css";
import "./settings-layout.css";
import "./usage.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
