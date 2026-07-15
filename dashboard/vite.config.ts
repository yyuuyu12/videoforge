import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5400,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:5401",
      "/preview": "http://localhost:5401",
    },
  },
});
