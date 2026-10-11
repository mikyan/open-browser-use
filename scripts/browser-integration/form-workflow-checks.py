"""Complete the synthetic form through typed public Python SDK methods only."""
import json
from pathlib import Path
import sys
import time
from urllib.parse import urlsplit
from uuid import uuid4

from open_browser_use import connect_open_browser_use


def run(endpoint, base_url):
    parsed = urlsplit(base_url)
    if parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost'}:
        raise ValueError('Synthetic loopback fixture required')
    key = 'python-form-' + uuid4().hex
    base = base_url.rstrip('/') + '/form-task/' + key
    browser = connect_open_browser_use(endpoint, session_id=key, timeout=15)
    trace, navigation = [], None
    def step(identifier, operation, expected=None):
        started = time.monotonic()
        result = operation()
        trace.append({'id': identifier, 'elapsedMs': (time.monotonic() - started) * 1000, 'result': result})
        if expected is not None:
            assert result == expected, (identifier, result, expected)
        return result
    try:
        tab = browser.new_tab(base + '?variant=1')
        heading = tab.locator('h3').filter(has_text='研发套装')
        cards = tab.locator('li').filter(has=heading)
        step('ambiguous-kit-count', cards.count, 3)
        kit = tab.locator('li').filter(has=heading, has_not=tab.get_by_text('停用', exact=True), visible=True).and_(tab.locator('[data-available="true"]'))
        step('composed-kit-count', kit.count, 1)
        step('choose-kit', kit.get_by_role('button', name='选用', exact=True).click)
        recipient = tab.get_by_role('group', name='收件信息', exact=True)
        step('recipient-name', lambda: recipient.get_by_label('姓名', exact=True).fill('林晓🧪'))
        step('recipient-key', lambda: recipient.get_by_label('姓名', exact=True).press('End'))
        step('recipient-email', lambda: recipient.get_by_label('邮箱', exact=True).fill('lin@example.test'))
        step('recipient-confirm', recipient.get_by_role('button', name='确认', exact=True).click)
        step('billing-unchanged', tab.get_by_role('group', name='账单信息', exact=True).get_by_label('姓名', exact=True).input_value, '保留此值')
        step('delivery-label-string', lambda: tab.get_by_role('combobox', name='配送方式', exact=True).select_option('自提'), ['pickup'])
        materials = tab.get_by_role('listbox', name='附加材料', exact=True)
        step('materials-mixed', lambda: materials.select_option(['手册', {'index': 2}]), ['manual', 'sticker'])
        step('materials-descriptors', lambda: materials.select_option([{'value': 'manual', 'label': '手册'}, {'label': '贴纸', 'index': 2}]), ['manual', 'sticker'])
        step('digital-voucher', tab.get_by_role('radio', name='电子凭证', exact=True).check)
        subscription = tab.get_by_role('checkbox', name='订阅通知', exact=True)
        step('unsubscribe', subscription.uncheck)
        step('unsubscribe-idempotent', subscription.uncheck)
        terms = tab.get_by_role('checkbox', name='接受模拟条款', exact=True)
        step('accept-terms', terms.check)
        step('accept-terms-idempotent', terms.check)
        step('shadow-greeting', lambda: tab.get_by_label('赠言', exact=True).fill('谢谢，团队 🚀'))
        for scope, title, note in [('same', '部门设置', '研发二组'), ('cross', '配送偏好', '周三上午')]:
            frame = tab.frame_locator(f'iframe[title="{title}"]')
            field = frame.get_by_label('备注', exact=True).and_(frame.locator('input[data-field="note"]'))
            step(scope + '-note', lambda: field.fill(note))
            step(scope + '-confirm', frame.get_by_role('button', name='确认', exact=True).click)
            step(scope + '-saved', lambda: frame.get_by_role('status').filter(has_text='已保存').wait_for('visible'))
        navigation = tab.expect_url(base + '/receipt', timeout_ms=10000)
        submit = tab.get_by_role('button', name='提交模拟申请', exact=True).or_(tab.get_by_role('button', name='发送模拟申请', exact=True)).filter(visible=True)
        step('submit-once', submit.click)
        navigation.result()
        navigation = None
        receipt = json.loads(tab.locator('#receipt-json').inner_text())
        step('read-server-evidence', tab.get_by_role('link', name='查看服务端证据', exact=True).click)
        evidence = json.loads(tab.locator('#evidence-json').inner_text())
        assert receipt == evidence['receipt'] and receipt['key'] == key
        assert evidence['acceptedSubmissions'] == evidence['submitAttempts'] == 1
        assert evidence['duplicateSubmissions'] == 0 and len(evidence['posts']) == 3
        return {'passed': True, 'key': key, 'variant': 1, 'receipt': receipt, 'evidence': evidence, 'trace': trace}
    finally:
        try:
            if navigation is not None:
                navigation.cancel()
        finally:
            try:
                browser.client.finalize_tabs([])
            finally:
                browser.close()


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) != 4:
        raise ValueError('usage: form-workflow-checks.py endpoint baseURL outputPath')
    result = run(*sys.argv[1:3])
    encoded = json.dumps(result, ensure_ascii=False)
    with Path(sys.argv[3]).open('x', encoding='utf-8') as output:
        output.write(encoded + '\n')
    print(encoded)
