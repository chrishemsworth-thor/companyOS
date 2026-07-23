/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Build-time API origin (e.g. https://api.companyos.com.my). When set, the
   * console is pinned to it: the login page hides the "API base URL" field
   * and any locally-stored override is ignored. Leave unset for local dev,
   * where the field stays editable and defaults to http://localhost:8787.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
