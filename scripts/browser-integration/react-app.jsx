import React, { useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [value, setValue] = useState("");
  return <><label>Controlled name<input value={value} onChange={event => setValue(event.target.value)} /></label><output id="controlled-result">{value}</output></>;
}
createRoot(document.getElementById("react-root")).render(<App />);
const shadow = document.querySelector("#shadow-host").attachShadow({ mode: "open" });
const button = document.createElement("button");
button.textContent = "Shadow action";
button.addEventListener("click", () => document.querySelector("#shadow-result").textContent = "clicked");
shadow.append(button);
