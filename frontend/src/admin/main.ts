import { mount } from "svelte";
import AdminApp from "./AdminApp.svelte";
import "../styles/admin.css";

const target = document.getElementById("app");
if (!target) throw new Error("Admin application root was not found");
mount(AdminApp, { target });
