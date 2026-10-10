"""Public Python SDK acceptance against the running production extension and host."""
import json
import sys
import base64
import struct
import re
from open_browser_use import connect_open_browser_use

endpoint, url = sys.argv[1:3]
browser = connect_open_browser_use(endpoint, session_id="python-browser-integration", turn_id="acceptance", timeout=15)
checks = []
try:
    tab = browser.new_tab(url)
    tab.get_by_role("button", name="ARIA named action", exact=True).click()
    assert tab.locator("#role-result").text_content() == "clicked"
    assert 'button "ARIA named action"' in tab.dom_snapshot()
    checks.append("role-name-and-snapshot")
    try:
        tab.get_by_role("button", name="Duplicate", exact=True).click(timeout_ms=400)
    except RuntimeError as error:
        assert "strict mode violation" in str(error)
    else:
        raise AssertionError("Duplicate locator unexpectedly succeeded")
    checks.append("strictness")
    tab.get_by_label("Controlled name").fill("Python 中文")
    assert tab.get_by_label("Controlled name").input_value() == "Python 中文"
    assert tab.locator("#controlled-result").text_content() == "Python 中文"
    tab.get_by_role("textbox", name="Rich editor").fill("Python rich text")
    assert tab.get_by_role("textbox", name="Rich editor").text_content() == "Python rich text"
    checks.append("controlled-and-contenteditable")
    tab.get_by_role("button", name="Shadow action").click()
    assert tab.locator("#shadow-result").text_content() == "clicked"
    for selector in ("#same-frame", "#cross-frame"):
        frame = tab.frame_locator(selector)
        frame.get_by_label("Frame field").fill("Python frame 中文")
        frame.get_by_role("button", name="Frame action").click()
        assert frame.get_by_label("Frame field").input_value() == "Python frame 中文"
        assert frame.locator("#frame-result").text_content() == "clicked"
    checks.append("shadow-and-frames")
    tab.evaluate("document.querySelector('#role-result').textContent='';globalThis.__integrationRootEvents=[]")
    capture = tab.snapshot_ai()
    assert capture["complete"] and capture["stats"]["bytes"] == len(capture["snapshot"].encode("utf-8"))
    # Parse only this fixture's unique accessible-name line. Untrusted page
    # text is not the production source of authorized refs.
    lines = [line for line in capture["snapshot"].splitlines() if 'button "ARIA named action"' in line]
    assert len(lines) == 1
    refs = re.findall(r"\[ref=([^\]]+)\]", lines[0])
    assert len(refs) == 1 and refs[0] in capture["refs"]
    referenced = tab.get_by_ref(capture["captureId"], refs[0])
    assert referenced.text_content() == "Icon"
    referenced.click()
    assert tab.locator("#role-result").text_content() == "clicked"
    assert tab.evaluate("__integrationRootEvents.some(event=>event.event==='click'&&event.trusted)")
    checks.append("bounded-ai-snapshot-ref-read-and-trusted-click")
    shot = tab.screenshot()
    png = base64.b64decode(shot["base64"], validate=True)
    assert shot["mimeType"] == "image/png" and png[:8] == b"\x89PNG\r\n\x1a\n"
    assert png[12:16] == b"IHDR"
    assert all(value > 0 for value in struct.unpack(">II", png[16:24]))
    checks.append("screenshot")
    assert tab.evaluate("document.title") == "OBU SDK fixture"
    tab.get_by_role("button", name="Engine action", exact=True).click()
    assert tab.locator("#engine-result").text_content() == "1"
    checks.append("raw-cdp-engine-coexistence")
    tab.goto(url + "?python-navigation=1")
    tab.wait_for_url(url + "?python-navigation=1")
    assert tab.playwright.engine_info["name"] == "playwright-crx"
    checks.append("navigation-and-metadata")
    browser.cdp.navigate(tab.id, url + "?python-raw-navigation=1")
    assert tab.url() == url + "?python-raw-navigation=1"
    checks.append("scoped-raw-navigation")
    tab.goto(url + "actions/a")
    tab.goto(url + "actions/b")
    assert tab.go_back()["url"] == url + "actions/a"
    assert tab.locator("h1").text_content() == "/actions/a"
    assert tab.go_forward()["url"] == url + "actions/b"
    visit = tab.locator("#visit").text_content()
    tab.reload()
    assert tab.locator("#visit").text_content() != visit
    checks.append("history-and-reload")
    field = tab.get_by_label("Type here")
    field.focus()
    assert tab.evaluate("document.activeElement.id") == "field"
    field.press_sequentially("Py1", delay=3)
    assert field.input_value() == "Py1"
    assert tab.evaluate("events.filter(e=>e.type==='keydown'&&e.id==='field'&&e.trusted).length") == 3
    tab.locator("#bottom").scroll_into_view_if_needed()
    assert tab.evaluate("document.querySelector('#bottom').getBoundingClientRect().bottom<=innerHeight")
    tab.locator("#source").scroll_into_view_if_needed()
    tab.locator("#source").drag_to(tab.locator("#drop"))
    assert tab.locator("#result").text_content() == "real drag"
    assert tab.evaluate("events.some(e=>e.type==='drop'&&e.id==='drop'&&e.trusted)")
    box = tab.locator("#pointer").bounding_box()
    tab.mouse.move(box["x"] + 10, box["y"] + 10)
    tab.mouse.down()
    tab.mouse.move(box["x"] + 65, box["y"] + 50, steps=4)
    tab.mouse.up()
    assert tab.evaluate("pointer.dataset.dragging") == "no"
    assert tab.locator("#pointer-result").text_content()
    checks.append("trusted-keys-scroll-html-drop-and-pointer-drag")
    tab.evaluate("console.log('Python diagnostics 中文')")
    diagnostic = tab.diagnostics(limit=200)
    assert any(entry.get("kind") == "console" and entry.get("text") == "Python diagnostics 中文" for entry in diagnostic["entries"])
    assert not tab.diagnostics(after=diagnostic["cursor"])["entries"]
    browser.client.turn_ended()
    try:
        tab.diagnostics(after=diagnostic["cursor"])
    except RuntimeError as error:
        assert "OBU_DIAGNOSTICS_EXPIRED" in str(error)
    else:
        raise AssertionError("Diagnostics cursor survived detach")
    assert not any(entry.get("text") == "Python diagnostics 中文" for entry in tab.diagnostics()["entries"])
    checks.append("diagnostics-pagination-and-turn-isolation")
    # Synchronous clients use the ready handle before the trigger; no thread or
    # second connection is needed to establish listener ordering.
    network = browser.new_tab()
    browser.cdp.navigate(network.id, url + "network-waits?key=python-network&mode=normal&status=201&method=POST")
    network_url = url + "network-waits/api?key=python-network&mode=normal&status=201"
    request = network.expect_request({"url": network_url, "method": "POST"}, timeout_ms=5000)
    response = network.expect_response({"url": network_url, "method": "POST", "status": 201}, timeout_ms=5000)
    network.get_by_role("button", name="Send main network request", exact=True).click()
    sent, received = request.result(), response.result()
    assert sent["event"] == "request" and received["event"] == "response"
    assert sent["requestId"] == received["requestId"]
    assert received["url"] == network_url and received["method"] == "POST" and received["status"] == 201
    assert received["resourceType"] == "fetch" and "python-network" in received["frameUrl"]
    assert response.result() == received
    assert network.evaluate("networkClicks") == [{"trusted": True}]
    network_counts = network.evaluate("fetch('/network-waits/stats?key=python-network').then(response=>response.json())", await_promise=True)
    assert len(network_counts["requests"]) == 1
    request.cancel()
    response.cancel()
    checks.append("network-wait-cold-ready-trusted-click-and-single-request")
    browser.client.finalize_tabs([])
    checks.append("finalize")
    print(json.dumps({"passed": True, "pythonVersion": sys.version, "checks": checks, "networkWait": received, "networkServer": network_counts}, ensure_ascii=False))
finally:
    browser.close()
