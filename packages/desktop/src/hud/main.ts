// Must stay the first import: in mock mode it installs the IPC stubs before any module talks to Tauri.
import '../dev/mock.ts'

import '@butterfly-record/ui/tokens.css'

import { mount } from 'svelte'

import Hud from './Hud.svelte'

document.addEventListener('contextmenu', (event) => event.preventDefault())

mount(Hud, { target: document.getElementById('hud')! })
