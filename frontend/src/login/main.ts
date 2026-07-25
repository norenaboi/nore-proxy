import { mount } from "svelte";
import LoginApp from "./LoginApp.svelte";
import "./login.css";

const target = document.getElementById("app");
if (!target) throw new Error("Login application root was not found");
mount(LoginApp, { target });
