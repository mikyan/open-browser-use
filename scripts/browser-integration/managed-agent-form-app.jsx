// The request body comes from React state. Reading or assigning DOM.value is
// deliberately not a substitute for the controlled component's onChange path.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";

const config = JSON.parse(document.getElementById("task-config").textContent);
const events = []; let overflow = false;
for (const type of ["pointerdown", "click", "keydown", "input", "change", "submit"]) document.addEventListener(type, event => {
  if (events.length >= 256) { overflow = true; return; }
  const node = event.composedPath()[0];
  events.push({ sequence: events.length, type, trusted: event.isTrusted, id: node.id ?? "",
    value: node instanceof HTMLSelectElement ? Array.from(node.selectedOptions, option => option.value) : ["checkbox", "radio"].includes(node.type) ? node.checked : String(node.value ?? "").slice(0, 256),
    key: event.key ?? "", at: Date.now() });
}, true);

function Greeting({ value, onChange }) {
  const host = useRef(null), [shadow, setShadow] = useState(null);
  useLayoutEffect(() => { setShadow(host.current.attachShadow({ mode: "open" })); }, []);
  return <div id="greeting-host" ref={host}>{shadow && createPortal(<><style>{"label{display:block;font:16px system-ui;margin:10px 0}textarea{font:inherit;padding:8px;width:90%}"}</style><label>Greeting <textarea id="greeting" value={value} onChange={event => onChange(event.target.value)} /></label></>, shadow)}</div>;
}

function App() {
  const [values, setValues] = useState({ recipientName: "", recipientEmail: "", billingName: "保留账单账户", kit: "", delivery: "", materials: [], voucher: "paper", subscribe: true, terms: false, greeting: "", recipientConfirmed: false });
  const [stateRevision, setRevision] = useState(0), [sameSaved, setSameSaved] = useState(false), [crossSaved, setCrossSaved] = useState(false);
  const [crossGeneration, setCrossGeneration] = useState(0), [previewLoaded, setPreviewLoaded] = useState(false), [status, setStatus] = useState("Complete the request and both settings.");
  const [submitting, setSubmitting] = useState(false), sameFrame = useRef(null), crossFrame = useRef(null), transitions = useRef([]), sent = useRef(false);
  const transition = kind => { transitions.current.push({ kind, at: Date.now() }); };
  const update = (key, value) => {
    setValues(previous => ({ ...previous, [key]: value, ...(["recipientName", "recipientEmail"].includes(key) ? { recipientConfirmed: false } : {}) }));
    setRevision(revision => revision + 1);
  };
  const choose = kit => {
    setValues(previous => ({ ...previous, kit, delivery: "", materials: [] })); setRevision(revision => revision + 1);
  };
  useEffect(() => {
    const saved = event => {
      const data = event.data;
      if (data?.tag !== "managed-agent-form-saved" || data.nonce !== config.nonce) return;
      if (data.scope === "same" && data.generation === 1 && event.source === sameFrame.current?.contentWindow && event.origin === config.rootOrigin && !sameSaved) {
        transition("same-saved"); setSameSaved(true); setCrossGeneration(1);
      } else if (data.scope === "cross" && data.generation === 2 && crossGeneration === 2 && event.source === crossFrame.current?.contentWindow && event.origin === config.crossOrigin && !crossSaved) {
        transition("cross-saved"); setCrossSaved(true);
      }
    };
    addEventListener("message", saved); return () => removeEventListener("message", saved);
  }, [sameSaved, crossSaved, crossGeneration]);
  const available = Boolean(values.kit && values.recipientName && values.recipientEmail && values.recipientConfirmed && values.delivery && values.materials.length && values.terms && values.greeting && sameSaved && crossSaved);
  const submit = async event => {
    event.preventDefault(); if (!available || sent.current) return; sent.current = true; setSubmitting(true); setStatus("Submitting the original request…");
    try {
      const response = await fetch(config.base + "/submit", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce: config.nonce, documentToken: config.documentToken, round: config.round, values, stateRevision, transitions: transitions.current, events, overflow }) });
      const data = await response.json(); if (!response.ok) throw Error(data.error); location.assign(data.receiptURL);
    } catch (error) { setStatus("Submission failed: " + error.message); }
  };
  return <>
    <form id="request-form" onSubmit={submit}>
      <section aria-label="Equipment kits"><h2>Choose equipment</h2><ul>
        <li><h3>Research kit</h3><p>Available · active</p><button id="choose-research" type="button" onClick={() => choose("research")}>Choose</button></li>
        <li><h3>Field kit</h3><p>Available · active</p><button id="choose-field" type="button" onClick={() => choose("field")}>Choose</button></li>
        <li><h3>Research kit</h3><p>Retired</p><button id="choose-retired" type="button" onClick={() => choose("retired")}>Choose</button></li>
      </ul><output id="kit-state">{values.kit ? `Selected: ${values.kit}` : "No kit selected"}</output></section>
      <fieldset><legend>Recipient details</legend>
        <label>Name <input id="recipient-name" autoComplete="off" value={values.recipientName} onChange={event => update("recipientName", event.target.value)} /></label>
        <label>Email <input id="recipient-email" type="email" autoComplete="off" value={values.recipientEmail} onChange={event => update("recipientEmail", event.target.value)} /></label>
        <button id="recipient-confirm" type="button" disabled={!values.recipientName || !values.recipientEmail} onClick={() => update("recipientConfirmed", true)}>Confirm</button>
        <output id="recipient-state">{values.recipientConfirmed ? "Recipient confirmed" : "Recipient not confirmed"}</output>
      </fieldset>
      <fieldset><legend>Billing details</legend><label>Name <input id="billing-name" value={values.billingName} onChange={event => update("billingName", event.target.value)} /></label>
        <button id="billing-confirm" type="button" onClick={() => setStatus("Billing confirmation is not needed for this request.")}>Confirm</button></fieldset>
      {values.kit && <fieldset><legend>Request options</legend>
        <label>Delivery <select id="delivery" value={values.delivery} onChange={event => update("delivery", event.target.value)}><option value="">Choose delivery</option>
          {values.kit === "research" && <option value="pickup">Pickup</option>}<option value="courier">Courier</option>{values.kit === "field" && <option value="freight">Freight</option>}</select></label>
        <label>Materials <select id="materials" multiple size="4" value={values.materials} onChange={event => update("materials", Array.from(event.target.selectedOptions, option => option.value))}>
          <option value="manual">Manual</option><option value="sticker">Stickers</option><option value="checklist">Checklist</option><option value="adapter">Adapter</option></select></label>
        <label><input id="voucher-paper" type="radio" name="voucher" value="paper" checked={values.voucher === "paper"} onChange={() => update("voucher", "paper")} /> Paper voucher</label>
        <label><input id="voucher-digital" type="radio" name="voucher" value="digital" checked={values.voucher === "digital"} onChange={() => update("voucher", "digital")} /> Digital voucher</label>
        <label><input id="subscribe" type="checkbox" checked={values.subscribe} onChange={event => update("subscribe", event.target.checked)} /> Subscribe</label>
        <label><input id="terms" type="checkbox" checked={values.terms} onChange={event => update("terms", event.target.checked)} /> Accept simulation terms</label>
        <Greeting value={values.greeting} onChange={value => update("greeting", value)} />
      </fieldset>}
      <section><h2>Independent settings</h2><iframe ref={sameFrame} id="same-frame" title="Department settings" src={config.base + "/frame/same"} />
        {sameSaved && <><p id="department-saved">Department settings saved.</p>
          <button id="replace-cross-frame" type="button" disabled={!previewLoaded || crossGeneration !== 1} onClick={() => { transition("cross-replaced"); setCrossGeneration(2); }}>Update delivery form</button>
          <iframe key={crossGeneration} ref={crossFrame} id="cross-frame" title="Delivery preferences" src={`${config.crossOrigin}${config.base}/frame/cross?generation=${crossGeneration}`} onLoad={() => {
            if (crossGeneration === 1) { transition("cross-preview-loaded"); setPreviewLoaded(true); }
            else if (crossGeneration === 2) transition("cross-current-loaded");
          }} />
        </>}
        {crossSaved && <p id="delivery-saved">Current delivery settings saved.</p>}
      </section>
      <output id="request-preview" aria-label="Request preview" style={{ overflowWrap: "anywhere" }}>{JSON.stringify(values)}</output>
      <p role="status" id="submit-status">{available && !submitting ? "All settings are ready. Submit once." : status}</p>
      <button id="submit-request" type="submit" disabled={!available || submitting}>Submit request</button>
    </form>
  </>;
}

createRoot(document.getElementById("app-root")).render(<App />);
