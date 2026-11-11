import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProposalsApp } from "./proposals-app";
import "../styles.css";
import "../treasury-theme.css";

/** The Treasury app's owner page (served by `app/server.ts`): its own root, without the gateway's Shell. */
document.documentElement.classList.add("treasury-theme", "dark");
createRoot(document.getElementById("root")!).render(<StrictMode><ProposalsApp /></StrictMode>);
