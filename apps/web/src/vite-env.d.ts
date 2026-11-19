interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** The `BuildVersion` of this bundle as JSON, set by `vite.config.ts`. */
  readonly VITE_BUILD_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
