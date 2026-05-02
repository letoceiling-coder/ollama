/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE: string;
  readonly VITE_API_AUTH: string;
  readonly VITE_TEXT_MODEL: string;
  readonly VITE_VISION_MODEL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
