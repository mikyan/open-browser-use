// Complete the research task through typed public SDK calls and visible DOM only.
// The caller never imports the fixture/oracle, issues HTTP requests, or evaluates page script.
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
)

var taskFields = []string{"quantity", "budget", "deadline", "pdWatts", "ethernetMbps", "warrantyMonths"}
var quoteFields = []string{"vendorId", "name", "revision", "unitPrice", "available", "pdWatts", "ethernetMbps"}
var termsFields = []string{"vendorId", "revision", "shipping", "deliverBy", "warrantyMonths"}
var numericField = map[string]bool{"quantity": true, "budget": true, "pdWatts": true, "ethernetMbps": true,
	"warrantyMonths": true, "unitPrice": true, "available": true, "shipping": true}
var digits = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

type object = map[string]any

func parseField(field, text string) (any, error) {
	value := strings.TrimSpace(text)
	if numericField[field] {
		number, err := strconv.Atoi(value)
		if err != nil || !digits.MatchString(value) || number > 1_000_000_000 {
			return nil, fmt.Errorf("invalid visible numeric field %s: %q", field, value)
		}
		return number, nil
	}
	if field == "deadline" || field == "deliverBy" {
		parsed, err := time.Parse("2006-01-02", value)
		if err != nil || parsed.Format("2006-01-02") != value {
			return nil, fmt.Errorf("invalid ISO date %q", value)
		}
	}
	if value == "" {
		return nil, fmt.Errorf("empty visible field %s", field)
	}
	return value, nil
}

func compare(requirements object, observations []object) (object, error) {
	if requirements["quantity"].(int) <= 0 {
		return nil, errors.New("the requested quantity must be positive")
	}
	rows := []object{}
	selection, minimum := "none", int64(0)
	tied := false
	summaries := []string{}
	for _, source := range observations {
		quote, terms := source["quote"].(object), source["terms"].(object)
		total := int64(requirements["quantity"].(int))*int64(quote["unitPrice"].(int)) + int64(terms["shipping"].(int))
		if total > 9_007_199_254_740_991 {
			return nil, errors.New("total exceeds the safe JSON integer range")
		}
		failures := []string{}
		for _, rule := range []struct {
			failed bool
			reason string
		}{
			{quote["available"].(int) < requirements["quantity"].(int), "数量不足"},
			{terms["deliverBy"].(string) > requirements["deadline"].(string), "到货超期"},
			{total > int64(requirements["budget"].(int)), "预算超限"},
			{quote["pdWatts"].(int) < requirements["pdWatts"].(int), "PD不足"},
			{quote["ethernetMbps"].(int) < requirements["ethernetMbps"].(int), "网速不足"},
			{terms["warrantyMonths"].(int) < requirements["warrantyMonths"].(int), "保修不足"},
		} {
			if rule.failed {
				failures = append(failures, rule.reason)
			}
		}
		reason := strings.Join(failures, "、")
		if len(failures) == 0 {
			reason = "满足全部要求"
			if selection == "none" || total < minimum {
				selection, minimum, tied = source["vendorId"].(string), total, false
			} else if total == minimum {
				tied = true
			}
		}
		row := object{"vendorId": source["vendorId"], "total": total, "eligible": len(failures) == 0,
			"reason": reason, "quoteURL": source["quoteURL"], "termsURL": source["termsURL"]}
		for _, field := range []string{"unitPrice", "available", "pdWatts", "ethernetMbps"} {
			row[field] = quote[field]
		}
		for _, field := range []string{"shipping", "deliverBy", "warrantyMonths"} {
			row[field] = terms[field]
		}
		rows = append(rows, row)
		summaries = append(summaries, fmt.Sprintf("方案 %s 总价 %d 元：%s", source["vendorId"], total, reason))
	}
	if tied {
		return nil, errors.New("visible data has tied compliant totals; no tie-break rule is specified")
	}
	conclusion := fmt.Sprintf("。依据各供应商当前报价与交付保修资料，推荐 %s，按最低合规总价选择。", selection)
	if selection == "none" {
		conclusion = "。依据各供应商当前报价与交付保修资料，三家均无合规方案，不推荐任何方案。"
	}
	return object{"rows": rows, "selection": selection, "summary": strings.Join(summaries, "；") + conclusion}, nil
}

func loopbackURL(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost") {
		return errors.New("synthetic loopback fixture URL required")
	}
	return nil
}

func equalJSON(left, right any) bool {
	normalize := func(value any) (any, error) {
		data, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		var normalized any
		err = json.Unmarshal(data, &normalized)
		return normalized, err
	}
	a, errA := normalize(left)
	b, errB := normalize(right)
	return errA == nil && errB == nil && reflect.DeepEqual(a, b)
}

func run(endpoint, baseURL, outputPath string, variant int) (detail object, err error) {
	detail = object{"caller": "go", "variant": variant, "trace": []object{}, "observations": []object{},
		"createdTabIds": []int{}, "keptTabIds": []int{}, "closedTabIds": []int{}}
	defer func() {
		if err != nil {
			detail["error"] = err.Error()
		}
	}()
	if variant < 1 || variant > 3 {
		return detail, errors.New("variant must be 1, 2, or 3")
	}
	if err = loopbackURL(baseURL); err != nil {
		return detail, err
	}
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return detail, err
	}
	key := "go-research-" + hex.EncodeToString(nonce[:])
	detail["key"] = key
	step := func(id string, operation func() (any, error)) (any, error) {
		item := object{"id": id, "startedAt": time.Now().UnixMilli()}
		detail["trace"] = append(detail["trace"].([]object), item)
		started := time.Now()
		value, failure := operation()
		item["elapsedMs"] = float64(time.Since(started)) / float64(time.Millisecond)
		if failure != nil {
			item["error"] = failure.Error()
			return value, fmt.Errorf("%s: %w", id, failure)
		}
		item["passed"] = true
		return value, nil
	}
	perform := func(id string, operation func() error) error {
		_, failure := step(id, func() (any, error) { return nil, operation() })
		return failure
	}
	browser, err := obu.ConnectOpenBrowserUse(obu.Options{SocketPath: endpoint, SessionID: key, Timeout: 15 * time.Second})
	if err != nil {
		return detail, err
	}
	finalized := false
	finalizeAttempted := false
	defer func() {
		if !finalized && !finalizeAttempted {
			keep := []obu.Params{}
			if detail["receipt"] != nil {
				keep = append(keep, obu.Params{"tabId": detail["reportTabId"], "status": "deliverable"})
			}
			cleanup, cleanupErr := step("failure-finalize", func() (any, error) { return browser.Client.FinalizeTabs(keep) })
			detail["failureCleanup"] = cleanup
			if cleanupErr != nil {
				detail["cleanupError"] = cleanupErr.Error()
				err = errors.Join(err, cleanupErr)
			} else {
				for _, tabID := range detail["createdTabIds"].([]int) {
					if len(keep) != 0 && tabID == keep[0]["tabId"] {
						detail["keptTabIds"] = append(detail["keptTabIds"].([]int), tabID)
					} else {
						detail["closedTabIds"] = append(detail["closedTabIds"].([]int), tabID)
					}
				}
			}
		}
		if closeErr := browser.Close(); closeErr != nil {
			detail["closeError"] = closeErr.Error()
			err = errors.Join(err, closeErr)
		}
	}()
	newTab := func(id, target string) (*obu.Tab, error) {
		if failure := loopbackURL(target); failure != nil {
			return nil, failure
		}
		value, failure := step(id+"-create", func() (any, error) { return browser.NewTab() })
		if failure != nil {
			return nil, failure
		}
		tab := value.(*obu.Tab)
		detail["createdTabIds"] = append(detail["createdTabIds"].([]int), tab.ID)
		_, failure = step(id+"-navigate", func() (any, error) { return tab.Goto(target) })
		return tab, failure
	}
	readFields := func(id string, scope *obu.Locator, fields []string) (object, error) {
		values := object{}
		if failure := perform(id+"-visible", func() error { return scope.WaitFor("visible") }); failure != nil {
			return values, failure
		}
		for _, field := range fields {
			text, failure := step(id+"-"+field, func() (any, error) {
				return scope.Locator(fmt.Sprintf(`dd[data-field="%s"]`, field)).InnerText(10 * time.Second)
			})
			if failure != nil {
				return values, failure
			}
			values[field], failure = parseField(field, text.(string))
			if failure != nil {
				return values, failure
			}
		}
		return values, nil
	}
	href := func(id string, locator *obu.Locator, documentURL string) (string, error) {
		value, failure := step(id, func() (any, error) { return locator.GetAttribute("href") })
		if failure != nil {
			return "", failure
		}
		pointer, ok := value.(*string)
		if !ok || pointer == nil {
			return "", fmt.Errorf("%s did not expose an href", id)
		}
		base, failure := url.Parse(documentURL)
		if failure != nil {
			return "", failure
		}
		reference, failure := url.Parse(*pointer)
		if failure != nil {
			return "", failure
		}
		resolved := base.ResolveReference(reference).String()
		return resolved, loopbackURL(resolved)
	}
	control, err := step("begin-turn", browser.Client.BeginTurn)
	if err != nil {
		return detail, err
	}
	state := control.(object)
	detail["scope"] = object{"session_id": key, "turn_id": state["nextTurnId"], "control_epoch": state["controlEpoch"]}
	briefURL := strings.TrimRight(baseURL, "/") + "/research-task/" + key + fmt.Sprintf("?variant=%d", variant)
	brief, err := newTab("brief", briefURL)
	if err != nil {
		return detail, err
	}
	detail["briefTabId"] = brief.ID
	taskText, err := step("read-task", func() (any, error) { return brief.Locator("body").InnerText(10 * time.Second) })
	if err != nil {
		return detail, err
	}
	requirements, err := readFields("requirements", brief.Locator("body"), taskFields)
	if err != nil {
		return detail, err
	}
	detail["task"] = object{"text": taskText, "requirements": requirements}
	supplierURLs := map[string]string{}
	for _, vendor := range []string{"a", "b", "c"} {
		supplierURLs[vendor], err = href("supplier-link-"+vendor, brief.Locator(fmt.Sprintf(`a[data-vendor="%s"]`, vendor)), briefURL)
		if err != nil {
			return detail, err
		}
	}
	reportURL, err := href("report-link", brief.Locator(`a[data-action="report"]`), briefURL)
	if err != nil {
		return detail, err
	}
	for _, vendor := range []string{"a", "b", "c"} {
		tab, failure := newTab("supplier-"+vendor, supplierURLs[vendor])
		if failure != nil {
			return detail, failure
		}
		observation := object{"vendorId": vendor, "tabId": tab.ID, "supplierURL": supplierURLs[vendor]}
		detail["observations"] = append(detail["observations"].([]object), observation)
		framedQuote, failure := step(vendor+"-quote-layout", func() (any, error) { return tab.Locator(`iframe[title="当前报价"]`).Count() })
		if failure != nil {
			return detail, failure
		}
		if framedQuote != 0 && framedQuote != 1 {
			return detail, errors.New("expected at most one current quote frame")
		}
		quoteScope := tab.Locator(`section[aria-label="当前报价"]`)
		if framedQuote == 1 {
			quoteScope = tab.FrameLocator(`iframe[title="当前报价"]`).Locator(`section[aria-label="当前报价"]`)
		}
		quote, failure := readFields(vendor+"-quote", quoteScope, quoteFields)
		observation["quote"] = quote
		if failure != nil {
			return detail, failure
		}
		observation["quoteURL"], failure = href(vendor+"-quote-source", quoteScope.Locator(`a[data-field="sourceURL"]`), supplierURLs[vendor])
		if failure != nil {
			return detail, failure
		}
		expand := tab.GetByRole("button", obu.RoleOptions{Name: "展开交付与保修", Exact: true})
		expandable, failure := step(vendor+"-terms-layout", func() (any, error) { return expand.Count() })
		if failure != nil {
			return detail, failure
		}
		if expandable != 0 && expandable != 1 {
			return detail, errors.New("expected at most one terms expansion button")
		}
		if expandable == 1 {
			if failure = perform(vendor+"-expand-terms", func() error {
				return expand.Click()
			}); failure != nil {
				return detail, failure
			}
		}
		termsScope := tab.FrameLocator(`iframe[title="交付与保修"]`).Locator(`section[aria-label="交付与保修"]`)
		terms, failure := readFields(vendor+"-terms", termsScope, termsFields)
		observation["terms"] = terms
		if failure != nil {
			return detail, failure
		}
		observation["termsURL"], failure = href(vendor+"-terms-source", termsScope.Locator(`a[data-field="sourceURL"]`), supplierURLs[vendor])
		if failure != nil {
			return detail, failure
		}
		if quote["vendorId"] != vendor || terms["vendorId"] != vendor {
			return detail, errors.New("supplier documents disagree about the vendor")
		}
		for _, pair := range []struct {
			document object
			url      string
		}{{quote, observation["quoteURL"].(string)}, {terms, observation["termsURL"].(string)}} {
			parsed, _ := url.Parse(pair.url)
			revisions := parsed.Query()["revision"]
			if len(revisions) != 1 || revisions[0] != pair.document["revision"] {
				return detail, errors.New("citation revision disagrees with its visible source")
			}
		}
	}
	report, err := compare(requirements, detail["observations"].([]object))
	if err != nil {
		return detail, err
	}
	detail["report"] = report
	output, err := newTab("report", reportURL)
	if err != nil {
		return detail, err
	}
	detail["reportTabId"] = output.ID
	for _, row := range report["rows"].([]object) {
		fields := output.Locator(fmt.Sprintf(`fieldset[data-vendor="%s"]`, row["vendorId"]))
		for _, field := range []string{"unitPrice", "shipping", "available", "deliverBy", "warrantyMonths", "pdWatts", "ethernetMbps", "total", "reason", "quoteURL", "termsURL", "eligible"} {
			target := fields.Locator(fmt.Sprintf(`[data-field="%s"]`, field))
			if err = perform(row["vendorId"].(string)+"-fill-"+field, func() error {
				if field == "eligible" {
					value := "no"
					if row[field].(bool) {
						value = "yes"
					}
					_, failure := target.SelectOption(obu.Params{"value": value})
					return failure
				}
				return target.Fill(fmt.Sprint(row[field]))
			}); err != nil {
				return detail, err
			}
		}
	}
	if err = perform("recommendation", func() error {
		_, failure := output.GetByLabel("推荐方案", obu.TextOptions{Exact: true}).SelectOption(obu.Params{"value": report["selection"]})
		return failure
	}); err != nil {
		return detail, err
	}
	if err = perform("summary", func() error {
		return output.GetByLabel("评审摘要", obu.TextOptions{Exact: true}).Fill(report["summary"].(string))
	}); err != nil {
		return detail, err
	}
	if err = perform("save-once", func() error {
		return output.GetByRole("button", obu.RoleOptions{Name: "保存评审报告", Exact: true}).Click()
	}); err != nil {
		return detail, err
	}
	if err = perform("wait-receipt", func() error {
		return output.Locator("#receipt-json").WaitFor("visible", obu.BrowserActionOptions{Timeout: 10 * time.Second})
	}); err != nil {
		return detail, err
	}
	receiptText, err := step("read-receipt", func() (any, error) { return output.Locator("#receipt-json").InnerText(10 * time.Second) })
	if err != nil {
		return detail, err
	}
	var receipt object
	if err = json.Unmarshal([]byte(receiptText.(string)), &receipt); err != nil {
		return detail, err
	}
	detail["receipt"] = receipt
	if receipt["version"] != float64(1) || receipt["key"] != key || receipt["variant"] != float64(variant) ||
		!equalJSON(receipt["rows"], report["rows"]) || receipt["selection"] != report["selection"] ||
		receipt["summary"] != report["summary"] || receipt["reportId"] == nil || receipt["reportId"] == "" || receipt["savedAt"] == nil {
		return detail, errors.New("saved report does not match the report derived from visible sources")
	}
	imageValue, err := step("receipt-screenshot", func() (any, error) {
		return output.Screenshot(obu.BrowserActionOptions{Args: obu.Params{"type": "png", "fullPage": true}})
	})
	if err != nil {
		return detail, err
	}
	image := imageValue.(obu.Screenshot)
	data, err := base64.StdEncoding.Strict().DecodeString(image.Base64)
	if err != nil {
		return detail, err
	}
	if image.MimeType != "image/png" || len(data) < 24 || string(data[:8]) != "\x89PNG\r\n\x1a\n" {
		return detail, errors.New("invalid receipt PNG")
	}
	screenshotPath := strings.TrimSuffix(outputPath, filepath.Ext(outputPath)) + "-receipt.png"
	if err = writeExclusive(screenshotPath, data); err != nil {
		return detail, err
	}
	hash := sha256.Sum256(data)
	detail["screenshot"] = object{"filename": filepath.Base(screenshotPath), "mimeType": "image/png", "bytes": len(data),
		"sha256": hex.EncodeToString(hash[:]), "width": binary.BigEndian.Uint32(data[16:20]), "height": binary.BigEndian.Uint32(data[20:24])}
	finalizeAttempted = true
	detail["finalizeResult"], err = step("finalize-deliverable", func() (any, error) {
		return browser.Client.FinalizeTabs([]obu.Params{{"tabId": output.ID, "status": "deliverable"}})
	})
	if err != nil {
		return detail, err
	}
	finalized = true
	detail["keptTabIds"] = []int{output.ID}
	// These acknowledged intentions are verified independently against native tabs by the runner.
	for _, tabID := range detail["createdTabIds"].([]int) {
		if tabID != output.ID {
			detail["closedTabIds"] = append(detail["closedTabIds"].([]int), tabID)
		}
	}
	return detail, nil
}

func writeExclusive(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	return errors.Join(writeErr, file.Close())
}

func main() {
	if len(os.Args) != 4 && len(os.Args) != 5 {
		fmt.Fprintln(os.Stderr, "usage: research-workflow-checks endpoint baseURL outputPath [variant]")
		os.Exit(1)
	}
	variant := 1
	var err error
	if len(os.Args) == 5 {
		variant, err = strconv.Atoi(os.Args[4])
	}
	var result object
	if err == nil {
		result, err = run(os.Args[1], os.Args[2], os.Args[3], variant)
	} else {
		result = object{"caller": "go", "error": err.Error()}
	}
	encoded, encodeErr := json.Marshal(result)
	if encodeErr == nil {
		encodeErr = writeExclusive(os.Args[3], append(encoded, '\n'))
	}
	if encodeErr != nil {
		err = errors.Join(err, encodeErr)
	} else {
		fmt.Println(string(encoded))
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
