import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { TeleprompterSlimApp } from "@/teleprompter-slim/TeleprompterSlimApp";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <TeleprompterSlimApp />
    </StrictMode>,
  );
}
