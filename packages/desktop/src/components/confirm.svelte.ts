export interface ConfirmRequest {
  title: string
  message: string
  confirmLabel: string
  danger: boolean
  resolve: (confirmed: boolean) => void
}

class ConfirmController {
  current = $state<ConfirmRequest | null>(null)

  ask(options: { title: string; message: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
    this.current?.resolve(false)
    return new Promise((resolve) => {
      this.current = { ...options, danger: options.danger ?? false, resolve }
    })
  }

  settle(confirmed: boolean) {
    const request = this.current
    this.current = null
    request?.resolve(confirmed)
  }
}

export const confirmDialog = new ConfirmController()
