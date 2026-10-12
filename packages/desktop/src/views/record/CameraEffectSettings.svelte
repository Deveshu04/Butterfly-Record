<script lang="ts">
  import { Icon, type IconName } from '@butterfly-record/ui'

  import Button from '../../components/Button.svelte'
  import SettingRow from '../../components/SettingRow.svelte'
  import Switch from '../../components/Switch.svelte'
  import { toasts } from '../../components/toasts.svelte.ts'
  import type { BlurStrength, CameraBackground, CameraEffects } from '../../lib/camera-effects.ts'
  import {
    cameraBackgroundPick,
    cameraBackgroundRead,
    type CameraEffectState,
  } from '../../lib/ipc.ts'

  let {
    effects,
    overlay,
    onchange,
  }: {
    effects: CameraEffects
    /** How the overlay is getting on with drawing the effect. */
    overlay: CameraEffectState
    onchange: (patch: (draft: CameraEffects) => void) => Promise<void>
  } = $props()

  const uid = $props.id()

  const BACKGROUNDS: { value: CameraBackground; label: string; icon: IconName }[] = [
    { value: 'none', label: 'None', icon: 'none' },
    { value: 'blur', label: 'Blur', icon: 'blur' },
    { value: 'image', label: 'Picture', icon: 'image' },
    { value: 'color', label: 'Color', icon: 'droplet' },
  ]

  const STRENGTHS: { value: BlurStrength; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'strong', label: 'Strong' },
  ]

  const COLORS = [
    { value: '#30353b', label: 'Graphite' },
    { value: '#5b6470', label: 'Slate' },
    { value: '#2f4a5f', label: 'Navy' },
    { value: '#3f5a4c', label: 'Forest' },
    { value: '#8a6f55', label: 'Walnut' },
    { value: '#e9e6df', label: 'Paper' },
  ]

  /** The custom color picker reports every movement; settings are written at most this often. */
  const COLOR_SAVE_MS = 120

  let picking = $state(false)
  let thumbnail = $state<string | null>(null)
  let pendingColor: string | null = null
  let colorTimer: ReturnType<typeof setTimeout> | null = null

  const customColor = $derived(!COLORS.some((color) => color.value === effects.color))

  const notice = $derived(
    overlay.status === 'failed'
      ? overlay.message
      : overlay.status === 'starting' && effects.background !== 'none'
        ? 'Getting the background ready…'
        : null,
  )

  $effect(() => {
    const name = effects.image
    if (!name) return
    let url: string | null = null
    let current = true
    cameraBackgroundRead(name)
      .then((bytes) => {
        if (!current) return
        url = URL.createObjectURL(new Blob([bytes]))
        thumbnail = url
      })
      .catch(() => {})
    return () => {
      current = false
      if (url) URL.revokeObjectURL(url)
      thumbnail = null
    }
  })

  async function pickPicture() {
    picking = true
    try {
      const name = await cameraBackgroundPick()
      if (name) {
        await onchange((draft) => {
          draft.image = name
          draft.background = 'image'
        })
      }
    } catch (failure) {
      toasts.error(failure)
    } finally {
      picking = false
    }
  }

  function chooseBackground(background: CameraBackground, fromKeyboard = false) {
    void onchange((draft) => (draft.background = background))
    // A click on Picture with nothing chosen yet goes straight to choosing one; arrowing
    // across the group must not open a dialog.
    if (background === 'image' && !effects.image && !fromKeyboard) void pickPicture()
  }

  function setColor(color: string) {
    void onchange((draft) => (draft.color = color))
  }

  function previewColor(color: string) {
    pendingColor = color
    colorTimer ??= setTimeout(flushColor, COLOR_SAVE_MS)
  }

  function flushColor() {
    if (colorTimer !== null) clearTimeout(colorTimer)
    colorTimer = null
    const color = pendingColor
    pendingColor = null
    if (color) setColor(color)
  }

  function step(event: KeyboardEvent): number {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return -1
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return 1
    return 0
  }

  /** Arrow keys move through a radio group and select as they go. */
  function arrow<T>(
    event: KeyboardEvent,
    values: readonly T[],
    current: T,
    select: (value: T) => void,
    idOf: (value: T) => string,
  ) {
    const move = step(event)
    if (move === 0) return
    event.preventDefault()
    const index = Math.max(0, values.indexOf(current))
    const next = values[(index + move + values.length) % values.length]
    if (next === undefined) return
    select(next)
    document.getElementById(idOf(next))?.focus()
  }
</script>

<SettingRow label="Background" stacked>
  <div class="background">
    <div class="segments" role="radiogroup" aria-label="Camera background">
      {#each BACKGROUNDS as option (option.value)}
        {@const checked = effects.background === option.value}
        <button
          type="button"
          id="{uid}-background-{option.value}"
          class="segment"
          role="radio"
          aria-checked={checked}
          tabindex={checked ? 0 : -1}
          onclick={() => chooseBackground(option.value)}
          onkeydown={(event) =>
            arrow(
              event,
              BACKGROUNDS.map((item) => item.value),
              effects.background,
              (value) => chooseBackground(value, true),
              (value) => `${uid}-background-${value}`,
            )}
        >
          <Icon name={option.icon} size={20} />
          <span>{option.label}</span>
        </button>
      {/each}
    </div>
    {#if notice}
      <p class="notice">{notice}</p>
    {/if}
  </div>
</SettingRow>

{#if effects.background === 'blur'}
  <SettingRow label="Blur strength" labelId="{uid}-strength">
    <div class="segments compact" role="radiogroup" aria-labelledby="{uid}-strength">
      {#each STRENGTHS as option (option.value)}
        {@const checked = effects.blur === option.value}
        <button
          type="button"
          id="{uid}-strength-{option.value}"
          class="segment"
          role="radio"
          aria-checked={checked}
          tabindex={checked ? 0 : -1}
          onclick={() => onchange((draft) => (draft.blur = option.value))}
          onkeydown={(event) =>
            arrow(
              event,
              STRENGTHS.map((item) => item.value),
              effects.blur,
              (value) => void onchange((draft) => (draft.blur = value)),
              (value) => `${uid}-strength-${value}`,
            )}
        >
          {option.label}
        </button>
      {/each}
    </div>
  </SettingRow>
{:else if effects.background === 'image'}
  <SettingRow
    label="Picture"
    description={effects.image
      ? 'A copy is kept in the app, so the original can be moved or deleted.'
      : 'Choose a picture to show behind you.'}
  >
    {#if effects.image && thumbnail}
      <img class="thumbnail" src={thumbnail} alt="" />
    {/if}
    <Button busy={picking} onclick={pickPicture}>{effects.image ? 'Change…' : 'Choose…'}</Button>
  </SettingRow>
{:else if effects.background === 'color'}
  <SettingRow label="Color" labelId="{uid}-color">
    <div class="swatches" role="radiogroup" aria-labelledby="{uid}-color">
      {#each COLORS as color, index (color.value)}
        {@const checked = effects.color === color.value}
        <button
          type="button"
          id="{uid}-color-{index}"
          class="swatch"
          role="radio"
          aria-checked={checked}
          aria-label={color.label}
          title={color.label}
          tabindex={checked || (customColor && index === 0) ? 0 : -1}
          style:--swatch={color.value}
          onclick={() => setColor(color.value)}
          onkeydown={(event) =>
            arrow(
              event,
              COLORS.map((item) => item.value),
              effects.color,
              setColor,
              (value) => `${uid}-color-${COLORS.findIndex((item) => item.value === value)}`,
            )}
        ></button>
      {/each}
      <label class="swatch custom" class:checked={customColor} title="Custom color" style:--swatch={effects.color}>
        <input
          type="color"
          aria-label="Custom color"
          value={effects.color}
          oninput={(event) => previewColor(event.currentTarget.value)}
          onchange={(event) => {
            pendingColor = event.currentTarget.value
            flushColor()
          }}
        />
        {#if !customColor}<Icon name="plus" size={14} />{/if}
      </label>
    </div>
  </SettingRow>
{/if}

<SettingRow label="Light touch-up" description="Gently brightens a dim picture." labelId="{uid}-touch-up">
  <Switch
    labelledby="{uid}-touch-up"
    checked={effects.touchUp}
    onchange={(on) => onchange((draft) => (draft.touchUp = on))}
  />
</SettingRow>

<style>
  .background {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
  }

  .segments {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    width: 100%;
    overflow: hidden;
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-control);
  }

  .segments.compact {
    grid-template-columns: repeat(2, auto);
    width: auto;
  }

  .segment {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-1);
    border: none;
    border-left: 1px solid var(--hairline);
    background: var(--bg-elevated);
    color: var(--fg-muted);
    font: inherit;
    font-size: var(--text-sm);
    line-height: 16px;
    cursor: pointer;
    transition: background-color var(--motion-fast);
  }

  .compact .segment {
    padding: 6px var(--space-3);
  }

  .segment:first-child {
    border-left: none;
  }

  .segment:hover {
    background: var(--fill-hover);
  }

  .segment:active {
    background: var(--fill-active);
  }

  .segment[aria-checked='true'] {
    background: color-mix(in srgb, var(--accent) 12%, var(--bg-elevated));
    color: var(--fg);
    font-weight: 500;
  }

  /* The group is clipped to its rounded corners, which would cut a focus ring outside it. */
  .segment:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .notice {
    margin: 0;
    color: var(--fg-muted);
    font-size: var(--text-sm);
    line-height: 16px;
  }

  .thumbnail {
    width: 56px;
    height: 32px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    object-fit: cover;
  }

  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .swatch {
    position: relative;
    display: grid;
    width: 24px;
    height: 24px;
    padding: 0;
    place-items: center;
    border: 1px solid var(--hairline-strong);
    border-radius: 50%;
    background: var(--swatch);
    color: var(--fg-muted);
    cursor: pointer;
  }

  .swatch[aria-checked='true'],
  .swatch.custom.checked {
    box-shadow:
      0 0 0 2px var(--bg-elevated),
      0 0 0 3.5px var(--accent);
  }

  .swatch:focus-visible,
  .swatch.custom:focus-within {
    outline: none;
    box-shadow: var(--focus);
  }

  .swatch.custom:not(.checked) {
    background: var(--bg-elevated);
    border-style: dashed;
  }

  .swatch.custom input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
  }
</style>
