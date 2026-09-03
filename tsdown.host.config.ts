import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Bundle the plugin's own runtime dependencies. A `dsh plugin add` that links a
  // checkout (`link:`) never installs the package's dependencies, which left the
  // host unable to import `gmessages`; with everything inlined the emitted
  // `lib/index.js` needs only the DSH peer packages the host already provides.
  noExternal: [/^gmessages(\/|$)/, /^zod(\/|$)/, /^@bufbuild\//, /^@noble\//],
})
