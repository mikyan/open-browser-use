package obu

import (
	"errors"
	"reflect"
)

// The engine also parses native selector strings; these checks bound SDK trees.
func copyLocatorSteps(steps []Params, nested bool) ([]Params, error) {
	count := 0
	var copyChain func([]Params, int) ([]Params, error)
	copyChain = func(chain []Params, depth int) ([]Params, error) {
		if len(chain) > 32 || (depth > 0 && len(chain) == 0) || depth > 8 {
			return nil, errors.New("locator tree exceeds chain/depth limits or has an empty operand")
		}
		out := make([]Params, len(chain))
		element := false
		for i, step := range chain {
			count++
			if step == nil || count > 128 {
				return nil, errors.New("locator tree exceeds 128 steps")
			}
			kind, _ := step["kind"].(string)
			if (nested || depth > 0) && (kind == "frame" || kind == "ref") {
				return nil, errors.New("nested locators cannot contain frame or ref steps")
			}
			switch kind {
			case "filter", "nth", "first", "last", "and", "or":
				if !element {
					return nil, errors.New("locator operation requires a preceding element")
				}
			}
			element = kind != "frame"
			item := Params{}
			for key, value := range step {
				item[key] = value
			}
			keys := []string{}
			if kind == "filter" {
				keys = []string{"has", "hasNot"}
				if value, ok := item["visible"]; ok {
					if _, ok := value.(bool); !ok {
						return nil, errors.New("visible must be boolean")
					}
				}
			} else if kind == "and" || kind == "or" {
				keys = []string{"locator"}
			}
			for _, key := range keys {
				value, exists := step[key]
				if !exists && kind == "filter" {
					continue
				}
				child, ok := value.([]Params)
				if !ok {
					return nil, errors.New("nested locator must be an element chain")
				}
				copied, err := copyChain(child, depth+1)
				if err != nil {
					return nil, err
				}
				item[key] = copied
			}
			out[i] = item
		}
		return out, nil
	}
	return copyChain(steps, 0)
}

func (l *Locator) operand(other *Locator, relative bool) ([]Params, error) {
	if l.err != nil {
		return nil, l.err
	}
	if other == nil || l.Tab == nil || other.Tab == nil || l.Tab.ID != other.Tab.ID || l.Tab.Browser == nil || other.Tab.Browser == nil || l.Tab.Browser.Client != other.Tab.Browser.Client {
		return nil, errors.New("locator composition requires the same tab and client")
	}
	if other.err != nil {
		return nil, other.err
	}
	outer, inner := l.locatorSteps(), other.locatorSteps()
	prefix := func(chain []Params) (int, error) {
		end := 0
		for i, step := range chain {
			if step["kind"] == "ref" {
				return 0, errors.New("ref locators cannot be composed")
			}
			if step["kind"] == "frame" {
				end = i + 1
			}
		}
		return end, nil
	}
	outerEnd, err := prefix(outer)
	if err != nil {
		return nil, err
	}
	innerEnd, err := prefix(inner)
	if err != nil {
		return nil, err
	}
	if (!relative || innerEnd > 0) && !reflect.DeepEqual(outer[:outerEnd], inner[:innerEnd]) {
		return nil, errors.New("locator operands must have the same frame prefix")
	}
	if len(inner[innerEnd:]) == 0 {
		return nil, errors.New("locator operand must be a nonempty element chain")
	}
	return copyLocatorSteps(inner[innerEnd:], true)
}

func (l *Locator) combine(kind string, other *Locator) *Locator {
	steps, err := l.operand(other, false)
	if err != nil {
		return &Locator{Tab: l.Tab, err: err}
	}
	return l.chain(Params{"kind": kind, "locator": steps})
}

func (l *Locator) And(other *Locator) *Locator { return l.combine("and", other) }
func (l *Locator) Or(other *Locator) *Locator  { return l.combine("or", other) }

func combinedLocatorBudget(chains ...[]Params) error {
	count := 0
	var visit func([]Params)
	visit = func(chain []Params) {
		for _, step := range chain {
			count++
			for _, key := range []string{"has", "hasNot", "locator"} {
				if nested, ok := step[key].([]Params); ok {
					visit(nested)
				}
			}
		}
	}
	for _, chain := range chains {
		visit(chain)
	}
	if count > 128 {
		return errors.New("action locator trees exceed 128 steps")
	}
	return nil
}
