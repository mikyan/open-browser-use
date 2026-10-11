"""Read the public research pages and deliver a report with the typed Python SDK.

No fixture/oracle import, HTTP client, evaluate, CDP, or page-script shortcut.
"""
import base64
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import struct
import sys
import time
from urllib.parse import parse_qs, urljoin, urlsplit
from uuid import uuid4

from open_browser_use import connect_open_browser_use


TASK_FIELDS = ("quantity", "budget", "deadline", "pdWatts", "ethernetMbps", "warrantyMonths")
QUOTE_FIELDS = ("vendorId", "name", "revision", "unitPrice", "available", "pdWatts", "ethernetMbps")
TERMS_FIELDS = ("vendorId", "revision", "shipping", "deliverBy", "warrantyMonths")
NUMBER_FIELDS = {"quantity", "budget", "pdWatts", "ethernetMbps", "warrantyMonths", "unitPrice", "available", "shipping"}


def parse_field(field, text):
    value = text.strip()
    if field in NUMBER_FIELDS:
        if not re.fullmatch(r"(?:0|[1-9][0-9]*)", value) or int(value) > 1_000_000_000:
            raise ValueError(f"Invalid visible numeric field {field}: {value!r}")
        return int(value)
    if field in {"deadline", "deliverBy"}:
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError(f"Invalid ISO date {value!r}")
    if not value:
        raise ValueError(f"Empty visible field {field}")
    return value


def compare(requirements, observations):
    """Compute from captured visible data; the fixture's expected answer is unavailable."""
    if requirements["quantity"] <= 0:
        raise ValueError("The requested quantity must be positive")
    rows = []
    for source in observations:
        quote, terms = source["quote"], source["terms"]
        total = requirements["quantity"] * quote["unitPrice"] + terms["shipping"]
        if total > 9_007_199_254_740_991:
            raise ValueError("Total exceeds the safe JSON integer range")
        failures = [reason for failed, reason in [
            (quote["available"] < requirements["quantity"], "数量不足"),
            (terms["deliverBy"] > requirements["deadline"], "到货超期"),
            (total > requirements["budget"], "预算超限"),
            (quote["pdWatts"] < requirements["pdWatts"], "PD不足"),
            (quote["ethernetMbps"] < requirements["ethernetMbps"], "网速不足"),
            (terms["warrantyMonths"] < requirements["warrantyMonths"], "保修不足"),
        ] if failed]
        rows.append({"vendorId": source["vendorId"], **{field: quote[field] for field in
                     ("unitPrice", "available", "pdWatts", "ethernetMbps")},
                     **{field: terms[field] for field in ("shipping", "deliverBy", "warrantyMonths")},
                     "total": total, "eligible": not failures,
                     "reason": "、".join(failures) if failures else "满足全部要求",
                     "quoteURL": source["quoteURL"], "termsURL": source["termsURL"]})
    candidates = sorted((row for row in rows if row["eligible"]), key=lambda row: row["total"])
    if len(candidates) > 1 and candidates[0]["total"] == candidates[1]["total"]:
        raise ValueError("Visible data has tied compliant totals; no tie-break rule is specified")
    selection = candidates[0]["vendorId"] if candidates else "none"
    summary = "；".join(f"方案 {row['vendorId']} 总价 {row['total']} 元：{row['reason']}" for row in rows)
    summary += ("。依据各供应商当前报价与交付保修资料，三家均无合规方案，不推荐任何方案。" if selection == "none"
                else f"。依据各供应商当前报价与交付保修资料，推荐 {selection}，按最低合规总价选择。")
    return {"rows": rows, "selection": selection, "summary": summary}


def loopback_url(value):
    parsed = urlsplit(value)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.username or parsed.password:
        raise ValueError("Synthetic loopback fixture URL required")
    return value


def run(endpoint, base_url, output_path, variant=1):
    if variant not in {1, 2, 3}:
        raise ValueError("variant must be 1, 2, or 3")
    loopback_url(base_url)
    key = "python-research-" + uuid4().hex
    detail = {"caller": "python", "key": key, "variant": variant, "trace": [],
              "observations": [], "createdTabIds": [], "keptTabIds": [], "closedTabIds": []}
    browser = None
    finalized = False
    finalize_attempted = False
    failure = None

    def step(identifier, operation):
        item = {"id": identifier, "startedAt": int(time.time() * 1000)}
        detail["trace"].append(item)
        started = time.monotonic()
        try:
            result = operation()
            item["passed"] = True
            return result
        except Exception as error:
            item["error"] = str(error)
            raise
        finally:
            item["elapsedMs"] = (time.monotonic() - started) * 1000

    def new_tab(identifier, url):
        # Retain each created ID even if its subsequent navigation fails.
        tab = step(identifier + "-create", browser.new_tab)
        detail["createdTabIds"].append(tab.id)
        step(identifier + "-navigate", lambda: tab.goto(loopback_url(url)))
        return tab

    def read_fields(identifier, scope, fields):
        step(identifier + "-visible", lambda: scope.locator(f'dd[data-field="{fields[0]}"]').wait_for("visible"))
        return {field: parse_field(field, step(identifier + "-" + field,
                lambda field=field: scope.locator(f'dd[data-field="{field}"]').inner_text())) for field in fields}

    def href(identifier, locator, document_url):
        value = step(identifier, lambda: locator.get_attribute("href"))
        if not isinstance(value, str):
            raise ValueError(identifier + " did not expose an href")
        return loopback_url(urljoin(document_url, value))

    try:
        browser = connect_open_browser_use(endpoint, session_id=key, timeout=15)
        control = step("begin-turn", browser.client.begin_turn)
        detail["scope"] = {"session_id": key, "turn_id": control["nextTurnId"], "control_epoch": control["controlEpoch"]}
        brief_url = base_url.rstrip("/") + "/research-task/" + key + f"?variant={variant}"
        brief = new_tab("brief", brief_url)
        detail["briefTabId"] = brief.id
        task_text = step("read-task", brief.locator("body").inner_text)
        requirements = read_fields("requirements", brief, TASK_FIELDS)
        detail["task"] = {"text": task_text, "requirements": requirements}
        supplier_urls = {vendor: href("supplier-link-" + vendor, brief.locator(f'a[data-vendor="{vendor}"]'), brief_url) for vendor in "abc"}
        report_url = href("report-link", brief.locator('a[data-action="report"]'), brief_url)
        for vendor, supplier_url in supplier_urls.items():
            tab = new_tab("supplier-" + vendor, supplier_url)
            observation = {"vendorId": vendor, "tabId": tab.id, "supplierURL": supplier_url}
            detail["observations"].append(observation)
            framed_quote = step(vendor + "-quote-layout", tab.locator('iframe[title="当前报价"]').count)
            if framed_quote not in {0, 1}:
                raise ValueError("Expected at most one current quote frame")
            quote_scope = tab if framed_quote == 0 else tab.frame_locator('iframe[title="当前报价"]')
            quote_scope = quote_scope.locator('section[aria-label="当前报价"]')
            quote = read_fields(vendor + "-quote", quote_scope, QUOTE_FIELDS)
            observation["quote"] = quote
            observation["quoteURL"] = href(vendor + "-quote-source", quote_scope.locator('a[data-field="sourceURL"]'), supplier_url)
            expand = tab.get_by_role("button", name="展开交付与保修", exact=True)
            expandable = step(vendor + "-terms-layout", expand.count)
            if expandable not in {0, 1}:
                raise ValueError("Expected at most one terms expansion button")
            if expandable:
                step(vendor + "-expand-terms", expand.click)
            terms_scope = tab.frame_locator('iframe[title="交付与保修"]').locator('section[aria-label="交付与保修"]')
            terms = read_fields(vendor + "-terms", terms_scope, TERMS_FIELDS)
            observation["terms"] = terms
            observation["termsURL"] = href(vendor + "-terms-source", terms_scope.locator('a[data-field="sourceURL"]'), supplier_url)
            if quote["vendorId"] != vendor or terms["vendorId"] != vendor:
                raise ValueError("Supplier documents disagree about the vendor")
            for document, url in [(quote, observation["quoteURL"]), (terms, observation["termsURL"])]:
                if parse_qs(urlsplit(url).query).get("revision") != [document["revision"]]:
                    raise ValueError("Citation revision disagrees with its visible source")
        report = compare(requirements, detail["observations"])
        detail["report"] = report
        output = new_tab("report", report_url)
        detail["reportTabId"] = output.id
        for row in report["rows"]:
            fields = output.locator(f'fieldset[data-vendor="{row["vendorId"]}"]')
            for field, value in row.items():
                if field == "vendorId":
                    continue
                target = fields.locator(f'[data-field="{field}"]')
                if field == "eligible":
                    step(row["vendorId"] + "-fill-" + field, lambda: target.select_option({"value": "yes" if value else "no"}))
                else:
                    step(row["vendorId"] + "-fill-" + field, lambda: target.fill(str(value)))
        step("recommendation", lambda: output.get_by_label("推荐方案", exact=True).select_option({"value": report["selection"]}))
        step("summary", lambda: output.get_by_label("评审摘要", exact=True).fill(report["summary"]))
        step("save-once", output.get_by_role("button", name="保存评审报告", exact=True).click)
        step("wait-receipt", lambda: output.locator("#receipt-json").wait_for("visible", timeout_ms=10000))
        receipt = json.loads(step("read-receipt", output.locator("#receipt-json").inner_text))
        detail["receipt"] = receipt
        if (receipt.get("version") != 1 or receipt.get("key") != key or receipt.get("variant") != variant
                or receipt.get("rows") != report["rows"] or receipt.get("selection") != report["selection"]
                or receipt.get("summary") != report["summary"] or not receipt.get("reportId") or not receipt.get("savedAt")):
            raise ValueError("Saved report does not match the report derived from visible sources")
        image = step("receipt-screenshot", lambda: output.screenshot(type="png", full_page=True))
        data = base64.b64decode(image["base64"], validate=True)
        if image["mimeType"] != "image/png" or data[:8] != b"\x89PNG\r\n\x1a\n" or len(data) < 24:
            raise ValueError("Invalid receipt PNG")
        screenshot = Path(output_path).with_name(Path(output_path).stem + "-receipt.png")
        with screenshot.open("xb") as handle:
            handle.write(data)
        width, height = struct.unpack(">II", data[16:24])
        detail["screenshot"] = {"filename": screenshot.name, "mimeType": "image/png", "bytes": len(data),
                                "sha256": hashlib.sha256(data).hexdigest(), "width": width, "height": height}
        finalize_attempted = True
        detail["finalizeResult"] = step("finalize-deliverable", lambda: browser.client.finalize_tabs([
            {"tabId": output.id, "status": "deliverable"}]))
        finalized = True
        detail["keptTabIds"] = [output.id]
        # These are acknowledged intentions; the runner independently inspects native tabs.
        detail["closedTabIds"] = [tab_id for tab_id in detail["createdTabIds"] if tab_id != output.id]
    except Exception as error:
        failure = error
        detail["error"] = str(error)
    finally:
        if browser is not None:
            if not finalized and not finalize_attempted:
                try:
                    keep = [{"tabId": detail["reportTabId"], "status": "deliverable"}] if "receipt" in detail else []
                    detail["failureCleanup"] = step("failure-finalize", lambda: browser.client.finalize_tabs(keep))
                    detail["keptTabIds"] = [entry["tabId"] for entry in keep]
                    detail["closedTabIds"] = [tab_id for tab_id in detail["createdTabIds"] if tab_id not in detail["keptTabIds"]]
                except Exception as error:
                    detail["cleanupError"] = str(error)
                    failure = failure or error
            try:
                browser.close()
            except Exception as error:
                detail["closeError"] = str(error)
                failure = failure or error
    if failure:
        failure.research_detail = detail
        raise failure
    return detail


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) not in {4, 5}:
        raise ValueError("usage: research-workflow-checks.py endpoint baseURL outputPath [variant]")
    failure = None
    try:
        result = run(*sys.argv[1:4], variant=int(sys.argv[4]) if len(sys.argv) == 5 else 1)
    except Exception as error:
        failure = error
        result = {**getattr(error, "research_detail", {}), "error": str(error)}
    encoded = json.dumps(result, ensure_ascii=False)
    with Path(sys.argv[3]).open("x", encoding="utf-8") as output_file:
        output_file.write(encoded + "\n")
    print(encoded)
    if failure:
        print(str(failure), file=sys.stderr)
        sys.exit(1)
