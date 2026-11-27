import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"

const DEFAULT_API_PROXY = "http://127.0.0.1:8080"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const apiProxy = env.VITE_API_PROXY !== undefined && env.VITE_API_PROXY !== "" ? env.VITE_API_PROXY : DEFAULT_API_PROXY
  const proxy = {
    "/api": {
      target: apiProxy,
      changeOrigin: true,
    },
  }

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy,
    },
    preview: {
      port: 4173,
      proxy,
    },
  }
})
