import { mount } from "svelte";
import PublicApp from "./PublicApp.svelte";
import "../styles/public.css";

const target = document.getElementById("app");

if (!target) {
  throw new Error("Public application root was not found");
}

mount(PublicApp, { target });
