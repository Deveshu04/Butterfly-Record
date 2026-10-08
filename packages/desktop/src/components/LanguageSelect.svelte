<script lang="ts">
  import { tick } from 'svelte'
  import { Icon } from '@butterfly-record/ui'
  import { LANGUAGES, type Language } from '../lib/languages.ts'

  type Capability = 'stt' | 'translate' | 'mayura' | 'tts' | 'dub'

  let {
    value = $bindable(),
    capability = null,
    allowAuto = false,
    exclude = [],
    onchange,
    id,
    label,
    placeholder = 'Choose a language',
    disabled = false,
    wide = false,
  }: {
    value: string | null
    /** Only languages the chosen Sarvam service supports. */
    capability?: Capability | null
    /** Adds "Auto-detect" (code 'unknown') at the top. */
    allowAuto?: boolean
    exclude?: string[]
    onchange?: (code: string) => void
    id?: string | undefined
    label?: string | undefined
    placeholder?: string
    disabled?: boolean
    wide?: boolean
  } = $props()

  const uid = $props.id()
  const AUTO: Language = {
    code: 'unknown',
    name: 'Auto-detect',
    native: '',
    stt: true,
    translate: false,
    mayura: false,
    tts: false,
    dub: false,
  }

  let open = $state(false)
  let query = $state('')
  let active = $state(0)
  let trigger: HTMLButtonElement | undefined = $state()
  let popover: HTMLDivElement | undefined = $state()
  let input: HTMLInputElement | undefined = $state()
  let list: HTMLUListElement | undefined = $state()
  let position = $state({ left: 0, top: 0, width: 0 })

  const choices = $derived.by(() => {
    const languages = LANGUAGES.filter(
      (language) => (capability === null || language[capability]) && !exclude.includes(language.code),
    )
    return allowAuto ? [AUTO, ...languages] : languages
  })

  const filtered = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return choices
    // Names that start with the query rank above names that merely contain it.
    const rank = (language: Language) => {
      const name = language.name.toLocaleLowerCase()
      if (name.startsWith(needle) || language.code.toLocaleLowerCase().startsWith(needle)) return 0
      if (name.includes(needle) || language.native.toLocaleLowerCase().includes(needle)) return 1
      return 2
    }
    return choices
      .map((language) => ({ language, rank: rank(language) }))
      .filter((entry) => entry.rank < 2)
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => entry.language)
  })

  const selected = $derived(
    value === 'unknown' && allowAuto ? AUTO : (LANGUAGES.find((language) => language.code === value) ?? null),
  )

  async function show() {
    if (disabled || !trigger || !popover) return
    query = ''
    active = Math.max(0, filtered.findIndex((language) => language.code === value))
    const rect = trigger.getBoundingClientRect()
    const width = Math.max(rect.width, 260)
    const height = 320
    const below = innerHeight - rect.bottom
    position = {
      left: Math.min(rect.left, innerWidth - width - 8),
      top: below < height + 8 && rect.top > below ? rect.top - height - 4 : rect.bottom + 4,
      width,
    }
    popover.showPopover()
    open = true
    await tick()
    input?.focus()
    scrollActive()
  }

  function hide(returnFocus = true) {
    if (!open) return
    open = false
    popover?.hidePopover()
    if (returnFocus) trigger?.focus()
  }

  function choose(language: Language) {
    value = language.code
    onchange?.(language.code)
    hide()
  }

  function scrollActive() {
    list?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  function inputKey(event: KeyboardEvent) {
    switch (event.key) {
      case 'ArrowDown':
        active = Math.min(filtered.length - 1, active + 1)
        break
      case 'ArrowUp':
        active = Math.max(0, active - 1)
        break
      case 'PageDown':
        active = Math.min(filtered.length - 1, active + 8)
        break
      case 'PageUp':
        active = Math.max(0, active - 8)
        break
      case 'Enter': {
        const language = filtered[active]
        if (language) choose(language)
        break
      }
      case 'Escape':
        event.stopPropagation()
        hide()
        break
      case 'Tab':
        hide(false)
        return
      default:
        return
    }
    event.preventDefault()
    scrollActive()
  }

  function triggerKey(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      void show()
    }
  }

  function outside(event: PointerEvent) {
    if (!open) return
    const target = event.target as Node
    if (popover?.contains(target) || trigger?.contains(target)) return
    hide(false)
  }

  function scrolled(event: Event) {
    if (!open) return
    if (event.target instanceof Node && popover?.contains(event.target)) return
    hide(false)
  }
</script>

<svelte:window onpointerdowncapture={outside} onresize={() => hide(false)} />
<svelte:document onscrollcapture={scrolled} />

<button
  bind:this={trigger}
  {id}
  type="button"
  class="trigger"
  class:wide
  aria-label={label}
  aria-haspopup="listbox"
  aria-expanded={open}
  {disabled}
  onclick={() => (open ? hide() : show())}
  onkeydown={triggerKey}
>
  {#if selected}
    <span class="name">{selected.name}</span>
    {#if selected.native && selected.native !== selected.name}<span class="native">{selected.native}</span>{/if}
  {:else}
    <span class="name placeholder">{placeholder}</span>
  {/if}
  <span class="chevron" aria-hidden="true"><Icon name="chevron-down" size={14} /></span>
</button>

<div
  bind:this={popover}
  popover="manual"
  class="popover"
  style:left="{position.left}px"
  style:top="{position.top}px"
  style:width="{position.width}px"
>
  <div class="search">
    <span class="lead" aria-hidden="true"><Icon name="search" size={14} /></span>
    <input
      bind:this={input}
      bind:value={query}
      type="text"
      role="combobox"
      aria-label="Search languages"
      aria-expanded={open}
      aria-controls="{uid}-list"
      aria-activedescendant={filtered[active] ? `${uid}-option-${active}` : undefined}
      aria-autocomplete="list"
      placeholder="Search languages"
      autocomplete="off"
      spellcheck="false"
      onkeydown={inputKey}
      oninput={() => (active = 0)}
    />
  </div>
  <ul bind:this={list} id="{uid}-list" role="listbox" aria-label={label ?? 'Languages'}>
    {#each filtered as language, index (language.code)}
      <!-- svelte-ignore a11y_click_events_have_key_events (the search box drives the list from the keyboard) -->
      <li
        id="{uid}-option-{index}"
        role="option"
        data-index={index}
        aria-selected={language.code === value}
        class:active={index === active}
        onpointermove={() => (active = index)}
        onpointerdown={(event) => event.preventDefault()}
        onclick={() => choose(language)}
      >
        <span class="name">{language.name}</span>
        {#if language.native && language.native !== language.name}<span class="native">{language.native}</span>{/if}
        {#if language.code === value}<span class="check"><Icon name="check" size={14} /></span>{/if}
      </li>
    {:else}
      <li class="none" role="presentation">No language matches “{query.trim()}”</li>
    {/each}
  </ul>
</div>

<style>
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    width: 220px;
    max-width: 100%;
    height: 32px;
    padding: 0 32px 0 var(--space-3);
    position: relative;
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-control);
    background: var(--bg-elevated);
    color: var(--fg);
    font-size: var(--text-md);
    text-align: left;
    cursor: pointer;
  }

  .trigger.wide {
    width: 100%;
  }

  .trigger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--bg-elevated), var(--fg) 4%);
  }

  .trigger:active:not(:disabled) {
    background: color-mix(in srgb, var(--bg-elevated), var(--fg) 8%);
  }

  .trigger:focus-visible {
    outline: none;
    box-shadow: var(--focus);
  }

  .trigger:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .placeholder {
    color: var(--fg-faint);
  }

  .native {
    overflow: hidden;
    color: var(--fg-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chevron {
    position: absolute;
    right: 10px;
    color: var(--fg-muted);
  }

  .popover {
    position: fixed;
    inset: auto;
    display: none;
    flex-direction: column;
    max-height: 320px;
    margin: 0;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-card);
    background: var(--bg-overlay);
    color: var(--fg);
    box-shadow: var(--shadow-pop);
  }

  .popover:popover-open {
    display: flex;
  }

  .search {
    position: relative;
    display: flex;
    align-items: center;
    padding: var(--space-2);
    border-bottom: 1px solid var(--hairline);
  }

  .search input {
    width: 100%;
    height: 32px;
    padding: 0 var(--space-2) 0 30px;
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-control);
    background: var(--bg-elevated);
    color: var(--fg);
    font-size: var(--text-md);
    user-select: text;
  }

  .search input:focus,
  .search input:focus-visible {
    border-bottom-color: var(--accent);
    outline: none;
    box-shadow: inset 0 -1px 0 var(--accent);
  }

  .search input::placeholder {
    color: var(--fg-faint);
  }

  .lead {
    position: absolute;
    left: 19px;
    color: var(--fg-muted);
    pointer-events: none;
  }

  ul {
    flex: 1;
    margin: 0;
    padding: var(--space-1);
    overflow-y: auto;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: 32px;
    padding: 0 var(--space-2);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  li.active {
    background: var(--fill-hover);
  }

  li[aria-selected='true'] {
    font-weight: 600;
  }

  li[aria-selected='true'] .native {
    font-weight: 400;
  }

  .check {
    display: grid;
    margin-left: auto;
    color: var(--fg);
  }

  .none {
    justify-content: center;
    height: 48px;
    color: var(--fg-muted);
    cursor: default;
  }
</style>
