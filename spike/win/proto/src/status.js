const log = document.getElementById("log");
const state = document.getElementById("state");
window.sbd.onLog((line) => { log.textContent += line + "\n"; log.scrollTop = log.scrollHeight; });
window.sbd.onState((text) => { state.textContent = text; });
