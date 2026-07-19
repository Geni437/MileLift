/**
 * Theme barrel — re-exports the canonical design tokens from
 * `docs/design/theme.ts` (owned by `ui-ux-designer`) so app code imports
 * from a stable `src/theme` path instead of reaching into `docs/` directly.
 *
 * Do NOT redefine or copy values here. If a screen needs a token that isn't
 * exported by `docs/design/theme.ts`, that file is the one to change (see
 * its own header comment) — never patch a literal in a component.
 */
export * from '../../docs/design/theme';
export { defaultTheme as theme } from '../../docs/design/theme';
