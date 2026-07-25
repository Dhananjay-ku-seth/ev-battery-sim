import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// EV Battery Management Simulator (LabBench, portfolio demo)
export default defineConfig({
  server: { host: "::", port: 5189 },
  plugins: [react()],
});
