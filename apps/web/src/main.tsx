import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { HostManager } from "./HostManager";
import "./styles.css";
import "./host-manager.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /><HostManager /></StrictMode>);
