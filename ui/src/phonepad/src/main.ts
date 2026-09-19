import "./styles.css";
import { PadController } from "./controller";
import { consumeToken, PadTransport } from "./transport";
import { bind, render } from "./view";

let generation = 0;
let controller = new PadController(null, render);
function pair(): void {
  const token = consumeToken(window.location, window.history);
  const current = ++generation;
  controller.dispose();
  controller = new PadController(token === null ? null : new PadTransport(token), (snapshot) => {
    if (current === generation) render(snapshot);
  });
  controller.setVisible(document.visibilityState === "visible");
}
bind(() => controller);
document.addEventListener("visibilitychange", () => controller.setVisible(document.visibilityState === "visible"));
window.addEventListener("pagehide", () => controller.dispose());
window.addEventListener("pageshow", (event) => { if (event.persisted) controller.setVisible(document.visibilityState === "visible"); });
window.addEventListener("hashchange", () => { if (window.location.hash) pair(); });
pair();
