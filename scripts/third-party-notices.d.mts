export interface ThirdPartyNoticesOptions {
  /** Product name used in the file's introduction. */
  product: string
  /** Cargo.toml of the binary whose linked crates are listed, relative to the Vite root. */
  cargoManifest?: string
  /** Rust target triple; defaults to TAURI_ENV_TARGET_TRIPLE, then the host. */
  target?: string
  /** Paragraphs added after the introduction. */
  notes?: string[]
  /** Output file name inside the build output; defaults to THIRD_PARTY_NOTICES.txt. */
  fileName?: string
}

export default function thirdPartyNotices(options: ThirdPartyNoticesOptions): { name: string }
