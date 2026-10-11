import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenBrowserUseBrowser, OpenBrowserUseClient, OpenBrowserUseLocator } from '../dist/index.js';

function setup() {
  const client = new OpenBrowserUseClient({ socketPath: 'unused' });
  const calls = [];
  client.browserAction = async (...args) => { calls.push(args); return { value: ['manual', 'sticker'] }; };
  const browser = new OpenBrowserUseBrowser({ client });
  return { browser, tab: browser.tab(7), calls };
}

test('compositions preserve structural frame scope and strip only exact prefixes', async () => {
  const { browser, tab, calls } = setup();
  const outer = tab.frameLocator('#child').getByRole('listitem');
  const siblingHandle = browser.tab(7);
  const selected = outer.filter({ has: siblingHandle.getByText('Research'), hasNot: siblingHandle.frameLocator('#child').getByText('Unavailable'), visible: false })
    .and(siblingHandle.frameLocator('#child').locator('.eligible')).or(tab.frameLocator('#child').getByTestId('backup'));
  await selected.click();
  assert.deepEqual(calls[0][2].locator, [
    { kind: 'frame', selector: '#child' }, { kind: 'role', role: 'listitem' },
    { kind: 'filter', visible: false, has: [{ kind: 'text', value: 'Research' }], hasNot: [{ kind: 'text', value: 'Unavailable' }] },
    { kind: 'and', locator: [{ kind: 'css', selector: '.eligible' }] },
    { kind: 'or', locator: [{ kind: 'testId', value: 'backup' }] },
  ]);
  const reordered = new OpenBrowserUseLocator(tab, [{ selector: '#child', kind: 'frame' }, { kind: 'css', selector: '.x' }]);
  assert.doesNotThrow(() => outer.and(reordered));
  assert.equal(outer.steps.length, 2);
});

test('different clients, frames, empty operands, refs and nested frame traversal fail before sending', () => {
  const { tab, calls } = setup();
  const outer = tab.frameLocator('#one').locator('article');
  for (const bad of [setup().tab.locator('a'), tab.browser.tab(8).locator('a')]) assert.throws(() => outer.filter({ has: bad }), /same tab and client/);
  for (const bad of [tab.frameLocator('#two').locator('a'), tab.locator('#container').frameLocator('#one').locator('a')]) assert.throws(() => outer.filter({ hasNot: bad }), /frame prefix/);
  assert.throws(() => outer.and(tab.locator('a')), /frame prefix/);
  assert.throws(() => outer.or(tab.frameLocator('#one')), /nonempty/);
  assert.throws(() => tab.locator('a').filter({ has: tab.getByRef('capture', 'e1') }), /Ref/);
  assert.throws(() => tab.getByRef('capture', 'e1').filter({ visible: false }), /Ref/);
  assert.throws(() => new OpenBrowserUseLocator(tab, [{ kind: 'css', selector: 'a' }, { kind: 'filter', hasNot: [{ kind: 'frame', selector: 'iframe' }, { kind: 'css', selector: 'b' }] }]), /frame or ref/);
  assert.throws(() => outer.filter({ visible: 'false' }), /boolean/);
  assert.equal(calls.length, 0);
});

test('operand input and exposed trees cannot mutate derived locators', () => {
  const { tab } = setup();
  const input = [{ kind: 'css', selector: '.choice' }, { kind: 'filter', has: [{ kind: 'text', value: 'Original' }] }];
  const other = new OpenBrowserUseLocator(tab, input);
  const composed = tab.locator('article').filter({ has: other });
  input[1].has[0].value = 'Changed';
  assert.equal(composed.steps[1].has[1].has[0].value, 'Original');
  assert.throws(() => other.steps[1].has[0].value = 'Changed', TypeError);
  assert.throws(() => composed.steps[1].has.push({kind:'last'}), TypeError);
});

test('locator tree and combined drag budgets have exact boundaries', async () => {
  const { tab, calls } = setup();
  const chain = Array.from({ length: 32 }, () => ({ kind: 'css', selector: '*' }));
  assert.equal(new OpenBrowserUseLocator(tab, chain).steps.length, 32);
  assert.throws(() => new OpenBrowserUseLocator(tab, [...chain, chain[0]]), /limits/);
  let nested = tab.locator('*');
  for (let i = 0; i < 8; i++) nested = tab.locator('*').filter({ has: nested });
  assert.throws(() => tab.locator('*').filter({ has: nested }), /depth/);
  const wide = new OpenBrowserUseLocator(tab, [{ kind: 'css', selector: '*' }, { kind: 'filter', has: chain, hasNot: chain }]);
  await assert.rejects(wide.dragTo(wide), /128/);
  assert.throws(() => wide.filter({has: wide}), /128/);
  const exact = new OpenBrowserUseLocator(tab, [chain[0], { kind: 'filter', has: chain.slice(1), hasNot: chain.slice(1) }, { kind: 'filter', has: chain, hasNot: chain.slice(1) }]);
  assert.throws(() => exact.last(), /128/);
  assert.equal(calls.length, 0);
});

test('mixed select options retain public string and descriptor semantics', async () => {
  const { tab, calls } = setup();
  const values = ['Manual', { value: 'sticker' }, { label: 'Bundle', index: 3 }];
  assert.deepEqual(await tab.getByLabel('Materials').selectOption(values, {timeoutMs: 500}), ['manual', 'sticker']);
  assert.deepEqual(calls[0][2].args.values, values);
  assert.equal(calls[0][2].timeoutMs, 500);
});
