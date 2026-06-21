import path from "node:path";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4201",
        changeOrigin: true
      },
      "/ws": {
        target: "ws://127.0.0.1:4201",
        ws: true
      }
    }
  },
  build: {
    outDir: path.resolve(__dirname, "../dist/web"),
    emptyOutDir: true
  }
});
