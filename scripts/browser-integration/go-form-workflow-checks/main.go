// Complete the synthetic form using typed public SDK methods, never DOM writes or direct POSTs.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"reflect"
	"strings"
	"time"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
)

func run(endpoint, baseURL string) (result map[string]any, err error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "http" || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost") {
		return nil, errors.New("synthetic loopback fixture required")
	}
	key := fmt.Sprintf("go-form-%d", time.Now().UnixNano())
	base := strings.TrimRight(baseURL, "/") + "/form-task/" + key
	browser, err := obu.ConnectOpenBrowserUse(obu.Options{SocketPath: endpoint, SessionID: key, Timeout: 15 * time.Second})
	if err != nil {
		return nil, err
	}
	var navigation *obu.NavigationWait
	defer func() {
		if navigation != nil {
			err = errors.Join(err, navigation.Cancel())
		}
		_, finalErr := browser.Client.FinalizeTabs(nil)
		err = errors.Join(err, finalErr, browser.Close())
	}()
	trace := []map[string]any{}
	perform := func(id string, operation func() error) error {
		started := time.Now()
		failure := operation()
		trace = append(trace, map[string]any{"id": id, "elapsedMs": float64(time.Since(started)) / float64(time.Millisecond)})
		if failure != nil {
			return fmt.Errorf("%s: %w", id, failure)
		}
		return nil
	}
	role := func(name string) obu.RoleOptions { return obu.RoleOptions{Name: name, Exact: true} }
	exact := obu.TextOptions{Exact: true}
	tab, err := browser.NewTab(obu.GotoOptions{URL: base + "?variant=1"})
	if err != nil {
		return nil, err
	}
	count, err := tab.Locator("li").Filter(obu.FilterOptions{Has: tab.Locator("h3").Filter(obu.FilterOptions{HasText: "研发套装"})}).Count()
	if err != nil || count != 3 {
		return nil, fmt.Errorf("ambiguous-kit-count %d: %v", count, err)
	}
	trace = append(trace, map[string]any{"id": "ambiguous-kit-count", "result": count})
	visible := true
	kit := tab.Locator("li").Filter(obu.FilterOptions{Has: tab.Locator("h3").Filter(obu.FilterOptions{HasText: "研发套装"}), HasNot: tab.GetByText("停用", exact), Visible: &visible}).And(tab.Locator(`[data-available="true"]`))
	count, err = kit.Count()
	if err != nil || count != 1 {
		return nil, fmt.Errorf("composed-kit-count %d: %v", count, err)
	}
	trace = append(trace, map[string]any{"id": "composed-kit-count", "result": count})
	recipient := tab.GetByRole("group", role("收件信息"))
	operations := []struct {
		id  string
		run func() error
	}{
		{"choose-kit", func() error { return kit.GetByRole("button", role("选用")).Click() }},
		{"recipient-name", func() error { return recipient.GetByLabel("姓名", exact).Fill("林晓🧪") }},
		{"recipient-key", func() error { return recipient.GetByLabel("姓名", exact).Press("End") }},
		{"recipient-email", func() error { return recipient.GetByLabel("邮箱", exact).Fill("lin@example.test") }},
		{"recipient-confirm", func() error { return recipient.GetByRole("button", role("确认")).Click() }},
		{"billing-unchanged", func() error {
			value, e := tab.GetByRole("group", role("账单信息")).GetByLabel("姓名", exact).InputValue()
			if e != nil {
				return e
			}
			if value != "保留此值" {
				return errors.New("billing changed")
			}
			return nil
		}},
	}
	selectValue := func(id string, locator *obu.Locator, values any, expected []string) {
		operations = append(operations, struct {
			id  string
			run func() error
		}{id, func() error {
			actual, e := locator.SelectOption(values)
			if e != nil {
				return e
			}
			if !reflect.DeepEqual(actual, expected) {
				return fmt.Errorf("selected %v", actual)
			}
			return nil
		}})
	}
	selectValue("delivery-label-string", tab.GetByRole("combobox", role("配送方式")), "自提", []string{"pickup"})
	selectValue("materials-mixed", tab.GetByRole("listbox", role("附加材料")), []any{"手册", obu.Params{"index": 2}}, []string{"manual", "sticker"})
	selectValue("materials-descriptors", tab.GetByRole("listbox", role("附加材料")), []any{obu.Params{"value": "manual", "label": "手册"}, obu.Params{"label": "贴纸", "index": 2}}, []string{"manual", "sticker"})
	operations = append(operations, []struct {
		id  string
		run func() error
	}{
		{"digital-voucher", func() error { return tab.GetByRole("radio", role("电子凭证")).Check() }},
		{"unsubscribe", func() error { return tab.GetByRole("checkbox", role("订阅通知")).Uncheck() }},
		{"unsubscribe-idempotent", func() error { return tab.GetByRole("checkbox", role("订阅通知")).Uncheck() }},
		{"accept-terms", func() error { return tab.GetByRole("checkbox", role("接受模拟条款")).Check() }},
		{"accept-terms-idempotent", func() error { return tab.GetByRole("checkbox", role("接受模拟条款")).Check() }},
		{"shadow-greeting", func() error { return tab.GetByLabel("赠言", exact).Fill("谢谢，团队 🚀") }},
	}...)
	for _, operation := range operations {
		if err = perform(operation.id, operation.run); err != nil {
			return nil, err
		}
	}
	for _, settings := range []struct{ scope, title, note string }{{"same", "部门设置", "研发二组"}, {"cross", "配送偏好", "周三上午"}} {
		frame := tab.FrameLocator(fmt.Sprintf(`iframe[title="%s"]`, settings.title))
		field := frame.GetByLabel("备注", exact).And(frame.Locator(`input[data-field="note"]`))
		if err = perform(settings.scope+"-note", func() error { return field.Fill(settings.note) }); err != nil {
			return nil, err
		}
		if err = perform(settings.scope+"-confirm", func() error { return frame.GetByRole("button", role("确认")).Click() }); err != nil {
			return nil, err
		}
		if err = perform(settings.scope+"-saved", func() error {
			return frame.GetByRole("status").Filter(obu.FilterOptions{HasText: "已保存"}).WaitFor("visible")
		}); err != nil {
			return nil, err
		}
	}
	navigation, err = tab.ExpectURL(base+"/receipt", obu.NavigationWaitOptions{Timeout: 10 * time.Second})
	if err != nil {
		return nil, err
	}
	submit := tab.GetByRole("button", role("提交模拟申请")).Or(tab.GetByRole("button", role("发送模拟申请"))).Filter(obu.FilterOptions{Visible: &visible})
	if err = perform("submit-once", func() error { return submit.Click() }); err != nil {
		return nil, err
	}
	if err = navigation.Result(); err != nil {
		return nil, err
	}
	navigation = nil
	readJSON := func(selector string) (map[string]any, error) {
		text, e := tab.Locator(selector).InnerText(10 * time.Second)
		if e != nil {
			return nil, e
		}
		var value map[string]any
		e = json.Unmarshal([]byte(text), &value)
		return value, e
	}
	receipt, err := readJSON("#receipt-json")
	if err != nil {
		return nil, err
	}
	if err = perform("read-server-evidence", func() error { return tab.GetByRole("link", role("查看服务端证据")).Click() }); err != nil {
		return nil, err
	}
	evidence, err := readJSON("#evidence-json")
	if err != nil {
		return nil, err
	}
	if !reflect.DeepEqual(receipt, evidence["receipt"]) || receipt["key"] != key || evidence["acceptedSubmissions"] != float64(1) || evidence["submitAttempts"] != float64(1) || evidence["duplicateSubmissions"] != float64(0) {
		return nil, errors.New("receipt/server evidence mismatch")
	}
	return map[string]any{"passed": true, "key": key, "variant": 1, "receipt": receipt, "evidence": evidence, "trace": trace}, nil
}

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: go-form-workflow-checks endpoint baseURL outputPath")
		os.Exit(1)
	}
	result, err := run(os.Args[1], os.Args[2])
	if err == nil {
		var data []byte
		data, err = json.Marshal(result)
		if err == nil {
			var file *os.File
			file, err = os.OpenFile(os.Args[3], os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if err == nil {
				_, writeErr := file.Write(append(data, '\n'))
				err = errors.Join(writeErr, file.Close())
				if err == nil {
					fmt.Println(string(data))
				}
			}
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
