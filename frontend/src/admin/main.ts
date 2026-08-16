import { mount } from "svelte";
import AdminApp from "./AdminApp.svelte";
import "../styles/admin.css";
// Must load after admin.css: it only adds animation and transform declarations
// on top of the base styles.
import "../styles/adminMotion.css";

const target = document.getElementById("app");
if (!target) throw new Error("Admin application root was not found");
mount(AdminApp, { target });
