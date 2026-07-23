import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["src/**/*.integration.ts"], testTimeout: 20_000 } });
