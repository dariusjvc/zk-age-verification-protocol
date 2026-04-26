import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  envDir: "..",
  plugins: [
    nodePolyfills({
      // snarkjs and circomlibjs require these Node.js built-ins
      include: ["buffer", "stream", "crypto", "path", "os"],
      globals: { Buffer: true, global: true },
    }),
  ],
  optimizeDeps: {
    include: ["snarkjs", "circomlibjs", "ethers"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2020",
    rollupOptions: {
      output: {
        manualChunks: {
          snarkjs:    ["snarkjs"],
          ethers:     ["ethers"],
          circomlib:  ["circomlibjs"],
        },
      },
    },
  },
  define: {
    // Required by snarkjs in browser
    "process.env": {},
  },
});
