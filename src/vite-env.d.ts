/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ANSWER_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
