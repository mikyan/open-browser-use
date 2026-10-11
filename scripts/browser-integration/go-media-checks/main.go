// Public Go SDK caller for the isolated media-download fixture. It never launches a browser.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image/color"
	"image/png"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
)

func collect(endpoint, baseURL string) (result map[string]any, err error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "http" || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost") {
		return nil, errors.New("synthetic loopback fixture required")
	}
	downloadRoot, err := filepath.EvalSymlinks(os.Getenv("OBU_TEST_DOWNLOAD_ROOT"))
	if err != nil {
		return nil, err
	}
	downloadRoot, err = filepath.Abs(downloadRoot)
	if err != nil {
		return nil, err
	}
	browser, err := obu.ConnectOpenBrowserUse(obu.Options{SocketPath: endpoint, SessionID: fmt.Sprintf("go-media-%d", time.Now().UnixNano()), TurnID: "acceptance", Timeout: 15 * time.Second})
	if err != nil {
		return nil, err
	}
	var download *obu.Download
	defer func() {
		if download != nil {
			err = errors.Join(err, download.Cancel(obu.DownloadOptions{Timeout: 5 * time.Second}))
		}
		_, finalErr := browser.Client.FinalizeTabs(nil)
		err = errors.Join(err, finalErr, browser.Close())
	}()
	breadth := os.Getenv("OBU_TEST_MEDIA_VARIANT") == "breadth"
	fixturePath, selector, filenameOption := "/media-downloads/page", "img#selected", "go-media.png"
	if breadth {
		fixturePath, selector, filenameOption = "/media-breadth/page", "#canvas", "go-media-breadth.png"
	}
	tab, err := browser.NewTab(obu.GotoOptions{URL: strings.TrimRight(baseURL, "/") + fixturePath})
	if err != nil {
		return nil, err
	}
	if err = tab.WaitForLoadState(obu.WaitForLoadStateOptions{State: obu.LoadStateLoad, Timeout: 5 * time.Second}); err != nil {
		return nil, err
	}
	var readiness any
	if breadth {
		readiness, err = tab.Evaluate("mediaReady", true)
		if err != nil {
			return nil, err
		}
	}
	download, err = tab.Locator(selector).DownloadMedia(obu.MediaDownloadOptions{Filename: filenameOption, Timeout: 5 * time.Second})
	if err != nil {
		return nil, err
	}
	filename, err := download.Path(obu.DownloadOptions{Timeout: 5 * time.Second})
	if err != nil {
		return nil, err
	}
	filename, err = filepath.EvalSymlinks(filename)
	if err != nil {
		return nil, err
	}
	filename, err = filepath.Abs(filename)
	if err != nil {
		return nil, err
	}
	relative, err := filepath.Rel(downloadRoot, filepath.Dir(filename))
	if err != nil || relative != "." {
		return nil, errors.New("download escaped this run's directory")
	}
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, err
	}
	image, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if image.Bounds().Dx() != 2 || image.Bounds().Dy() != 1 || color.NRGBAModel.Convert(image.At(0, 0)) != (color.NRGBA{255, 0, 0, 255}) || color.NRGBAModel.Convert(image.At(1, 0)) != (color.NRGBA{0, 255, 0, 255}) {
		return nil, errors.New("expected synthetic red/green 2x1 PNG")
	}
	result = map[string]any{"passed": true, "path": filename, "bytes": len(data), "sha256": fmt.Sprintf("%x", sha256.Sum256(data)), "base64": base64.StdEncoding.EncodeToString(data)}
	if breadth {
		page, readErr := tab.Evaluate("({events:mediaEvents,traps:getterTraps})")
		if readErr != nil {
			return nil, readErr
		}
		encoded, encodeErr := json.Marshal(page)
		if encodeErr != nil || string(encoded) != `{"events":[],"traps":[]}` {
			return nil, errors.New("media download invoked page getter or input")
		}
		result["kind"], result["readiness"], result["page"] = "canvas", readiness, page
	}
	return result, nil
}

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: go-media-checks endpoint baseURL outputPath")
		os.Exit(1)
	}
	result, err := collect(os.Args[1], os.Args[2])
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
