import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['reference-dsh-imessage/**', 'node_modules/**'],
    server: {
      deps: {
        external: [/@deepseek-ai\//],
        inline: ['gmessages'],
      },
    },
  },
})
