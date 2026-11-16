import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadSystem, validateSystem, renderCss, checkSystem } = require('../scripts/design-system.cjs');

test('approved design, shared CSS and project entry points remain synchronized', () => {
  assert.equal(validateSystem(checkSystem()), true);
});

test('rejects an 11px label even if a caller tries to reuse a historical role', () => {
  const system = structuredClone(loadSystem());
  system.tokens.typography['field-label'].fontSize = '11px';
  assert.throws(() => renderCss(system), /12px/);
});

test('rejects a newly added small-text role below the approved minimum', () => {
  const system = structuredClone(loadSystem());
  system.tokens.typography.footnote = { ...system.tokens.typography.caption, fontSize: '10px' };
  assert.throws(() => renderCss(system), /12px/);
});

test('rejects restoring the historical 19px author-card exception', () => {
  const system = structuredClone(loadSystem());
  system.tokens.rounded['author-panel'] = '19px';
  assert.throws(() => renderCss(system), /18px/);
});

test('rejects a card silently switching to a button radius', () => {
  const system = structuredClone(loadSystem());
  system.tokens.components['author-panel'].rounded = '{rounded.compact-control}';
  assert.throws(() => renderCss(system), /18px/);
});

test('rejects unapproved recoloring and shadow changes', () => {
  const recolor = structuredClone(loadSystem());
  recolor.tokens.colors['cat-accent'] = '#FF0066';
  assert.throws(() => renderCss(recolor), /发生变化/);
  const shadow = structuredClone(loadSystem());
  shadow.sidecar.extensions.shadows[0].value = '4px 4px 0 #000';
  assert.throws(() => renderCss(shadow), /发生变化/);
});

test('preserves distinct window, button and card shapes', () => {
  const { tokens } = loadSystem();
  assert.equal(tokens.rounded.window, '0px');
  assert.equal(tokens.rounded['compact-control'], '10px');
  assert.equal(tokens.rounded.panel, '18px');
  assert.equal(tokens.rounded.navigation, '17px');
});
