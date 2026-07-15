import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    copyPublicDir: false,
  },
  server: {
    port: 5174,
    fs: { allow: [".."] },
  },
});
