import { mount } from 'svelte'
import '@butterfly-record/ui/tokens.css'
import App from './App.svelte'

export default mount(App, { target: document.getElementById('app')! })
