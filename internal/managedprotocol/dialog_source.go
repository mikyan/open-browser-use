package managedprotocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	"golang.org/x/net/idna"
)

// DialogSource is display-only native provenance. Its value representation
// keeps copies independent, and omitzero preserves legacy source omission.
type DialogSource struct {
	Origin string `json:"origin"`
	Frame  string `json:"frame"`
}

// Match the URL host's UTS46 validation, without imposing DNS registration
// length/ASCII restrictions on browser origins. IP serialization is below.
var dialogHostProfile = idna.New(idna.MapForLookup(), idna.Transitional(false),
	idna.StrictDomainName(false), idna.ValidateLabels(true), idna.CheckHyphens(false),
	idna.CheckJoiners(true), idna.VerifyDNSLength(false), idna.BidiRule())

func parseDialogSource(raw json.RawMessage) (DialogSource, error) {
	f, err := Object(raw)
	if err != nil || !exact(f, []string{"origin", "frame"}, nil) || !dialogText(f["origin"], 2048, false, false) || !choice(f["frame"], "top-level", "child") {
		return DialogSource{}, errors.New("invalid human dialog source")
	}
	var source DialogSource
	_ = json.Unmarshal(raw, &source)
	if !canonicalDialogOrigin(source.Origin) {
		return DialogSource{}, errors.New("invalid human dialog source origin")
	}
	return source, nil
}

func canonicalDialogOrigin(origin string) bool {
	// Browser origins serialize IDNs as ASCII and never carry URL paths or
	// credentials. Do not normalize here: a differing serialization is rejected.
	for _, r := range origin {
		if r <= 32 || r >= 127 {
			return false
		}
	}
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" && u.Scheme != "https" || u.Opaque != "" || u.User != nil || u.Host == "" || u.Path != "" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.ContainsAny(origin, "#%\\") || origin != u.Scheme+"://"+u.Host {
		return false
	}
	host := u.Hostname()
	if host == "" || host != strings.ToLower(host) {
		return false
	}
	canonicalHost := host
	if strings.Contains(host, ":") {
		ip, err := netip.ParseAddr(host)
		if err != nil || !ip.Is6() || ip.Zone() != "" {
			return false
		}
		canonical := ip.String()
		if ip.Is4In6() {
			b := ip.As16()
			canonical = fmt.Sprintf("::ffff:%x:%x", uint16(b[12])<<8|uint16(b[13]), uint16(b[14])<<8|uint16(b[15]))
		}
		if host != canonical {
			return false
		}
		canonicalHost = "[" + host + "]"
	} else {
		if strings.ContainsAny(host, "[]<>^|") {
			return false
		}
		ascii, err := dialogHostProfile.ToASCII(host)
		if err != nil || ascii != host {
			return false
		}
		last := host[strings.LastIndex(host, ".")+1:]
		if strings.HasSuffix(host, ".") {
			trimmed := strings.TrimSuffix(host, ".")
			last = trimmed[strings.LastIndex(trimmed, ".")+1:]
		}
		digits := func(value, alphabet string) bool {
			for _, c := range value {
				if !strings.ContainsRune(alphabet, c) {
					return false
				}
			}
			return true
		}
		numeric := last != "" && (digits(last, "0123456789") || strings.HasPrefix(last, "0x") && digits(last[2:], "0123456789abcdef"))
		if numeric {
			ip, err := netip.ParseAddr(host)
			if err != nil || !ip.Is4() || ip.String() != host {
				return false
			}
		}
	}
	port := u.Port()
	if port != "" {
		n, err := strconv.ParseUint(port, 10, 16)
		if err != nil || strconv.FormatUint(n, 10) != port || u.Scheme == "http" && n == 80 || u.Scheme == "https" && n == 443 {
			return false
		}
		canonicalHost += ":" + port
	}
	return u.Host == canonicalHost
}
