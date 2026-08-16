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
