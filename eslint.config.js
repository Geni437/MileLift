const expoConfig = require('eslint-config-expo/flat');
const { defineConfig } = require('eslint/config');

module.exports = defineConfig([
  expoConfig,
  {
    // supabase/functions/** runs on Deno (Edge Functions), a separate
    // runtime/toolchain from this project's Node/Expo app — it uses Deno-only
    // import specifiers (e.g. `npm:@supabase/supabase-js@2`, `Deno.serve`)
    // that ESLint's Node-based resolver cannot and should not try to resolve.
    // This is the same class of exclusion as ios/*, android/* below (a
    // different build/runtime's output/source, not this app's TS graph).
    ignores: ['dist/*', 'node_modules/*', '.expo/*', 'ios/*', 'android/*', 'supabase/functions/**'],
  },
]);
