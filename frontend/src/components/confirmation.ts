export type ConfirmationRequest = { title: string; message: string; confirmLabel: string; onConfirm: () => void }

/** Consume before invoking: repeated clicks cannot run the accepted action twice. */
export function createConfirmationController() {
  let pending: ConfirmationRequest | null = null
  return {
    request(next: ConfirmationRequest) {
      if (pending) return false
      pending = next
      return true
    },
    resolve(accepted: boolean) {
      const current = pending
      pending = null
      if (!current) return false
      if (accepted) current.onConfirm()
      return true
    },
  }
}
