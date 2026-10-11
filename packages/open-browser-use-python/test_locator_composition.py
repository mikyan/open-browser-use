import unittest
from open_browser_use.client import OpenBrowserUseBrowser
from open_browser_use._browser_actions import OpenBrowserUseLocator
from test_browser_actions import RecordingClient


class LocatorCompositionTests(unittest.TestCase):
    def setUp(self):
        self.client = RecordingClient('unused')
        self.browser = OpenBrowserUseBrowser(self.client)
        self.tab = self.browser.tab(7)

    def test_frame_relative_operands_and_false_visibility(self):
        outer = self.tab.frame_locator('#child').get_by_role('listitem')
        other = self.browser.tab(7)
        composed = outer.filter(has=other.get_by_text('Research'), has_not=other.frame_locator('#child').get_by_text('Unavailable'), visible=False)
        composed.and_(other.frame_locator('#child').locator('.eligible')).or_(other.frame_locator('#child').get_by_test_id('backup')).click()
        steps = self.client.calls[0][1]['locator']
        self.assertEqual(steps[2], {'kind': 'filter', 'visible': False, 'has': [{'kind': 'text', 'value': 'Research', 'exact': False}], 'hasNot': [{'kind': 'text', 'value': 'Unavailable', 'exact': False}]})
        self.assertEqual(steps[3], {'kind': 'and', 'locator': [{'kind': 'css', 'selector': '.eligible'}]})
        self.assertEqual(len(outer._steps), 2)
        reordered = OpenBrowserUseLocator(self.tab, [{'selector': '#child', 'kind': 'frame'}, {'kind': 'css', 'selector': 'a'}])
        outer.and_(reordered)

    def test_cross_client_frame_ref_and_empty_operands_rejected(self):
        outer = self.tab.frame_locator('#one').locator('article')
        foreign = OpenBrowserUseBrowser(RecordingClient('unused')).tab(7).locator('a')
        for other in (foreign, self.browser.tab(8).locator('a')):
            with self.assertRaisesRegex(ValueError, 'same tab and client'): outer.filter(has=other)
        for other in (self.tab.frame_locator('#two').locator('a'), self.tab.locator('section').frame_locator('#one').locator('a')):
            with self.assertRaisesRegex(ValueError, 'frame prefix'): outer.filter(has_not=other)
        with self.assertRaisesRegex(ValueError, 'frame prefix'): outer.and_(self.tab.locator('a'))
        with self.assertRaisesRegex(ValueError, 'nonempty'): outer.or_(self.tab.frame_locator('#one'))
        with self.assertRaisesRegex(ValueError, 'Ref'): outer.filter(has=self.tab.get_by_ref('capture', 'e1'))
        with self.assertRaisesRegex(ValueError, 'boolean'): outer.filter(visible=0)
        with self.assertRaisesRegex(ValueError, 'frame or ref'):
            OpenBrowserUseLocator(self.tab, [{'kind': 'css', 'selector': 'a'}, {'kind': 'filter', 'hasNot': [{'kind': 'frame', 'selector': 'iframe'}, {'kind': 'css', 'selector': 'b'}]}])
        self.assertEqual(self.client.calls, [])

    def test_deep_copy_and_bounds(self):
        source = [{'kind': 'css', 'selector': '*'}, {'kind': 'filter', 'has': [{'kind': 'text', 'value': 'Original'}]}]
        operand = OpenBrowserUseLocator(self.tab, source)
        composed = self.tab.locator('article').filter(has=operand)
        source[1]['has'][0]['value'] = 'changed'
        operand._steps[1]['has'][0]['value'] = 'also changed'
        self.assertEqual(composed._steps[1]['has'][1]['has'][0]['value'], 'Original')
        chain = [{'kind': 'css', 'selector': '*'} for _ in range(32)]
        OpenBrowserUseLocator(self.tab, chain)
        with self.assertRaisesRegex(ValueError, 'limits'): OpenBrowserUseLocator(self.tab, chain + chain[:1])
        nested = self.tab.locator('*')
        for _ in range(8): nested = self.tab.locator('*').filter(has=nested)
        with self.assertRaisesRegex(ValueError, 'depth'): self.tab.locator('*').filter(has=nested)
        wide = OpenBrowserUseLocator(self.tab, [{'kind': 'css', 'selector': '*'}, {'kind': 'filter', 'has': chain, 'hasNot': chain}])
        with self.assertRaisesRegex(ValueError, '128'): wide.drag_to(wide)
        with self.assertRaisesRegex(ValueError, '128'): wide.filter(has=wide)
        exact = OpenBrowserUseLocator(self.tab, [chain[0], {'kind': 'filter', 'has': chain[1:], 'hasNot': chain[1:]}, {'kind': 'filter', 'has': chain, 'hasNot': chain[1:]}])
        with self.assertRaisesRegex(ValueError, '128'): exact.last

    def test_mixed_select_preserves_values(self):
        values = ['Manual', {'value': 'sticker'}, {'label': 'Bundle', 'index': 3}]
        self.tab.get_by_label('Materials').select_option(values, timeout_ms=500)
        self.assertEqual(self.client.calls[0][1]['args']['values'], values)
        self.assertEqual(self.client.calls[0][1]['timeoutMs'], 500)
