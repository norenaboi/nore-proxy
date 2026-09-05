import { mount } from "svelte";
import PublicApp from "./PublicApp.svelte";
import "../styles/public.css";
// Must load after public.css: it only adds animation and transform declarations
// on top of the base styles.
import "../styles/publicMotion.css";

const target = document.getElementById("app");

if (!target) {
  throw new Error("Public application root was not found");
}

mount(PublicApp, { target });
// The document paints a static copy of the theme toggle so it is on screen
// before this bundle runs. Removing it here, in the same task as the mount,
// swaps in the real control before the browser paints — the two are identical,
// so the exchange is invisible.
document.getElementById("theme-pill-placeholder")?.remove();

