// Migration files are bundled into the data worker as text, through Vite's `?raw` suffix
// (electron-vite at build time, Vitest in tests).
declare module '*.sql?raw' {
  const sql: string;
  export default sql;
}
