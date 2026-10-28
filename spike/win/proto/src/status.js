const log = document.getElementById("log");
const state = document.getElementById("state");
const screen = document.getElementById("screen");
const screenTitle = document.getElementById("screen-title");
const screenText = document.getElementById("screen-text");
window.sbd.onLog((line) => { log.textContent += line + "\n"; log.scrollTop = log.scrollHeight; });
window.sbd.onState((text) => { state.textContent = text; });
// Shell screens (follow.ts): the stack or its GUI was stopped on purpose, or a start failed. Start runs the kit's start again.
window.sbd.onScreen((s) => {
  screen.hidden = false;
  if (s.kind === "server-stopped") {
    state.textContent = "The stack was stopped";
    screenTitle.textContent = "The sb server was stopped on purpose.";
    screenText.textContent = "Start it again to get the GUI back.";
  } else if (s.kind === "gui-stopped") {
    state.textContent = "The GUI was stopped";
    screenTitle.textContent = "The GUI was stopped on purpose.";
    screenText.textContent = "The sb server still runs. Start brings the GUI back.";
  } else {
    state.textContent = "Start failed";
    screenTitle.textContent = "The stack could not be started" + (s.code === null || s.code === undefined ? "." : " (exit " + s.code + ").");
    screenText.textContent = s.text || "";
  }
});
document.getElementById("start").addEventListener("click", () => {
  screen.hidden = true;
  state.textContent = "Starting...";
  window.sbd.start();
});
