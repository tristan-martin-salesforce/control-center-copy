import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';
import { ccPlugin } from './src/components/kit/lint/no-internal-ids.mjs';
import { builtinRules } from 'eslint/use-at-your-own-risk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

/**
 * 01-ui-audit R10: new component code is Tailwind + tokens only. These files imported a CSS module when the rule landed
 * (2026-11-20); they may keep theirs until they are migrated. Never add a path.
 */
const CSS_MODULE_IMPORTERS = [
  'src/components/chat/AskBar.tsx',
  'src/components/chat/AssistantPage.tsx',
  'src/components/chat/AssistantPanel.tsx',
  'src/components/chat/AssistantSkeleton.tsx',
  'src/components/chat/card-parts.tsx',
  'src/components/chat/ChatActionCards.tsx',
  'src/components/chat/ChatComposer.tsx',
  'src/components/chat/ChatDock.tsx',
  'src/components/chat/ChatDockParts.tsx',
  'src/components/chat/ChatMessages.tsx',
  'src/components/chat/ChatProposalCard.tsx',
  'src/components/chat/ChatReceiptCard.tsx',
  'src/components/chat/ChatResourceCard.tsx',
  'src/components/chat/ThreadContextPane.tsx',
  'src/components/chat/ToolRows.tsx',
  'src/components/domain/ActivityRow.tsx',
  'src/components/onboarding/OnboardingFrame.tsx',
  'src/components/onboarding/OnboardingPage.tsx',
  'src/components/onboarding/OnboardingSkeleton.tsx',
  'src/components/onboarding/steps.head.tsx', // steps.tsx, split under max-lines (2026-11-21): the same code, not new
  'src/components/onboarding/steps.profile.tsx',
  'src/components/onboarding/steps.review.tsx',
  'src/components/onboarding/steps.sources.tsx',
  'src/components/settings/AboutSection.tsx',
  'src/components/settings/AgentSection.tsx',
  'src/components/settings/BasicSections.tsx',
  'src/components/settings/ClosingSection.tsx',
  'src/components/settings/controls.tsx',
  'src/components/settings/effects.tsx',
  'src/components/settings/form.tsx',
  'src/components/settings/PolicyEffect.tsx',
  'src/components/settings/PolicySection.tsx',
  'src/components/settings/RoleSection.tsx',
  'src/components/settings/ScanningSection.tsx',
  'src/components/settings/SettingsPage.tsx',
  'src/components/settings/SettingsSkeleton.tsx',
  'src/components/settings/SourcesSections.tsx',
  'src/components/settings/TimeSection.tsx',
];

// ---- BEGIN p1-docs-reset: definitions (layer table + max-lines; see CONTRIBUTING.md) ----
/** Test files are exempt from both rules: tests may reach across layers and may be long. */
const TEST_FILES = ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**', 'tests/**'];
/** One restricted-imports rule (warn) for a set of banned top-level `src/` dirs; type-only imports stay allowed. */
const bannedLayers = (dirs) => ({
  '@typescript-eslint/no-restricted-imports': ['error', {
    patterns: [{ group: dirs.flatMap((d) => [`@/${d}`, `@/${d}/**`]), allowTypeImports: true, message: 'Layer rule: this layer may not import that one (CONTRIBUTING.md "Where code goes").' }],
  }],
});
/**
 * Layer violations that existed when the rule landed (2026-11-20). Each path may keep its edge until it is fixed;
 * remove the path when it is. Never add one.
 */
const LAYER_GRANDFATHERED = [
  // empty since 2026-11-21: every entry was fixed (docs/reviews/2026-11-20-holistic/22-max-lines.md §6)
];
/**
 * The 11 files over 1,000 lines when the rule landed (2026-11-20). They are exempt from the 1,000-line error (they still
 * warn at 600) until split; remove an entry when its file is under 1,000 counted lines. Never add one.
 */
const LONG_FILES_GRANDFATHERED = [
  // empty since 2026-11-21: every entry was split under 1,000 (docs/reviews/2026-11-20-holistic/22-max-lines.md)
];
const LEN_OPTS = { skipBlankLines: true, skipComments: true };
/** ESLint allows one level per rule, so the 1,000-line error is the core max-lines rule registered a second time. */
const sizePlugin = { rules: { 'max-lines': builtinRules.get('max-lines') } };
const LAYER_AND_LENGTH_RULES = [
  // Pure layers: never import server, db, components, worker or llm.
  { files: ['src/{contract,lib,engines,personas,projections}/**/*.{ts,tsx}'], ignores: [...TEST_FILES, ...LAYER_GRANDFATHERED], rules: bannedLayers(['server', 'db', 'components', 'worker', 'llm']) },
  // UI: never import server or db.
  { files: ['src/{components,client,ui}/**/*.{ts,tsx}'], ignores: [...TEST_FILES, ...LAYER_GRANDFATHERED], rules: bannedLayers(['server', 'db']) },
  // Connectors: never import engines or server.
  { files: ['src/connectors/**/*.{ts,tsx}'], ignores: [...TEST_FILES, ...LAYER_GRANDFATHERED], rules: bannedLayers(['engines', 'server']) },
  // File length: warn at 600, error at 1,000 (blank lines and comments not counted). Tests are exempt.
  { files: ['src/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}', 'scripts/**/*.{ts,mjs}'], ignores: TEST_FILES, rules: { 'max-lines': ['warn', { max: 600, ...LEN_OPTS }] } },
  { files: ['src/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}', 'scripts/**/*.{ts,mjs}'], ignores: [...TEST_FILES, ...LONG_FILES_GRANDFATHERED], plugins: { size: sizePlugin }, rules: { 'size/max-lines': ['error', { max: 1000, ...LEN_OPTS }] } },
];
// ---- END p1-docs-reset: definitions ----

const config = [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      '.next-*/**',
      'out/**',
      'coverage/**',
      '.shots/**',
      '.claude/**',
      'tools/**',
      'public/**',
      'test-results/**',
      'playwright-report/**',
      'next-env.d.ts',
      'src/db/migrations/**',
      // its own checks: npm run sample:lint (ENG-1)
      'sample-data/**',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // 01-ui-audit R10 (warn first, error later): no new CSS modules in components; use Tailwind and the tokens.
    files: ['src/components/**/*.{ts,tsx}'],
    ignores: CSS_MODULE_IMPORTERS,
    rules: {
      'no-restricted-imports': ['warn', { patterns: [{ group: ['*.module.css'], message: 'New component code uses Tailwind and the tokens in app/globals.css, not CSS modules (docs/UX.md "Component kit").' }] }],
    },
  },
  {
    // 01-ui-audit R10 (warn): no "D-63" or "Use_Case__c" in what the screen shows. Grandfathered hits:
    // src/components/kit/lint/internal-ids-grandfathered.json; src/components/kit/__tests__/internal-ids.test.ts fails on a new one.
    files: ['src/components/**/*.tsx'],
    plugins: { cc: ccPlugin },
    rules: { 'cc/no-internal-ids-in-jsx': 'warn' },
  },
  // >>> p1-connector-runtime: the model provider seam (08 R6, decision H-4) >>>
  {
    // Only the provider adapter (and the Claude env helper) talks to the Agent SDK; everything else goes through
    // `@/llm/provider` (agentQuery, modelProvider(), the re-exported types). The typescript-eslint variant keeps it
    // apart from the components' CSS-module `no-restricted-imports` block above (flat config does not merge one rule).
    files: ['src/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}'],
    ignores: ['src/llm/provider/**', 'src/llm/claude-env.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { paths: [{ name: '@anthropic-ai/claude-agent-sdk', message: 'Import the model provider instead: `@/llm/provider` (agentQuery, modelProvider(), the SDK types). Only src/llm/provider/** may import the Agent SDK.' }] }],
    },
  },
  // <<< p1-connector-runtime <<<
  {
    // Tests may poke at untyped fixtures.
    files: ['tests/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  // ---- BEGIN p1-docs-reset: layer + file-length rules (10-engineering-system R4/R5, ENG-4; CONTRIBUTING.md "Where code goes") ----
  ...LAYER_AND_LENGTH_RULES,
  // ---- END p1-docs-reset ----
];

export default config;
