// Must stay the first import: in mock mode it installs the IPC stubs before any module talks to Tauri.
import '../dev/mock.ts'

import { mount } from 'svelte'

import Camera from './Camera.svelte'

document.addEventListener('contextmenu', (event) => event.preventDefault())

mount(Camera, { target: document.getElementById('camera')! })
