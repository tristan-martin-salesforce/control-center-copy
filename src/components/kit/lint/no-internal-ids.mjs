/**
 * ESLint rule `cc/no-internal-ids-in-jsx` (01-ui-audit R10, UI-3): no decision ids ("D-63") and no Salesforce API
 * names ("Use_Case__c") in what the screen shows. It checks JSX text and the string literals that render as JSX: an
 * attribute value (title, aria-label, a component's `body` prop…) and a string or template inside `{…}`, through
 * `cond ? 'a' : 'b'`, `a && 'b'` and `'a' + b`. Class names, keys, ids, links and data-* attributes are not text.
 *
 * Current hits are grandfathered by `path: token` in internal-ids-grandfathered.json (shrink it; never grow it). The
 * rule is a warning in eslint.config.mjs; src/components/kit/__tests__/internal-ids.test.ts fails on a new hit.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INTERNAL_ID_RE = /\bD-\d+\b|\b[A-Za-z0-9_]*[A-Za-z0-9]__c\b/g;

/** Attributes whose strings are not shown as text. */
export const NOT_TEXT_ATTR = /^(className|class|key|id|href|src|to|target|rel|type|name|role|htmlFor|data-.*|testId|ref)$/;

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..', '..');

/** "path: token" entries that may stay (paths relative to the repo root, forward slashes). */
export const GRANDFATHERED = new Set(JSON.parse(readFileSync(join(here, 'internal-ids-grandfathered.json'), 'utf8')).hits);

export function repoPath(file) {
  return relative(REPO, file).split(sep).join('/');
}

const PASS_THROUGH = new Set(['ConditionalExpression', 'LogicalExpression', 'BinaryExpression', 'TemplateLiteral', 'TSAsExpression', 'ParenthesizedExpression']);

/** True when a string node renders as JSX text (see the header). */
function rendersAsText(node) {
  let child = node;
  let p = node.parent;
  while (p && PASS_THROUGH.has(p.type)) {
    if (p.type === 'ConditionalExpression' && p.test === child) return false;
    child = p;
    p = p.parent;
  }
  if (!p) return false;
  if (p.type === 'JSXExpressionContainer') {
    const attr = p.parent?.type === 'JSXAttribute' ? p.parent : null;
    return !attr || !NOT_TEXT_ATTR.test(attrName(attr));
  }
  if (p.type === 'JSXAttribute' && p.value === child) return !NOT_TEXT_ATTR.test(attrName(p));
  return false;
}

function attrName(attr) {
  const n = attr.name;
  return n.type === 'JSXNamespacedName' ? `${n.namespace.name}:${n.name.name}` : n.name;
}

/** The internal ids in a string. */
export function internalIdsIn(text) {
  return [...String(text).matchAll(INTERNAL_ID_RE)].map((m) => m[0]);
}

export const noInternalIdsInJsx = {
  meta: {
    type: 'suggestion',
    docs: { description: 'No decision ids (D-63) or Salesforce API names (Use_Case__c) in JSX text' },
    messages: { internal: 'Internal id "{{token}}" in user-facing text: say it in plain words (01-ui-audit R10).' },
    // { all: true } reports grandfathered hits too (the test lists them)
    schema: [{ type: 'object', properties: { all: { type: 'boolean' } }, additionalProperties: false }],
  },
  create(context) {
    const file = repoPath(context.filename ?? context.getFilename());
    const all = !!context.options[0]?.all;
    const check = (node, text) => {
      for (const token of internalIdsIn(text)) {
        if (!all && GRANDFATHERED.has(`${file}: ${token}`)) continue;
        context.report({ node, messageId: 'internal', data: { token } });
      }
    };
    return {
      JSXText(node) {
        check(node, node.value);
      },
      Literal(node) {
        if (typeof node.value === 'string' && rendersAsText(node)) check(node, node.value);
      },
      TemplateElement(node) {
        if (node.parent && rendersAsText(node.parent)) check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};

export const ccPlugin = { rules: { 'no-internal-ids-in-jsx': noInternalIdsInJsx } };
