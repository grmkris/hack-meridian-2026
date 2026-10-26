/** Vite's `?raw` import of a Markdown file (the bundled skill in tests): the file's text. */
declare module '*.md?raw' {
  const text: string
  export default text
}
