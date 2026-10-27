# Development

## Editors

TypeScript language features use the pinned `tsrs` compiler and lint uses the repository's oxlint configuration.
Effect diagnostics have no language-server integration; run `bun run typecheck` for them.

Run `bun install --frozen-lockfile` and `bun scripts/tsrs-lint.ts` before opening the editor. No `node_modules`
patching is used. The npm pin is `tsrs@0.18.0-ts7.1.0-dev.20260929`; when adopting a release that ships `tsdk/`
(planned for 0.19), point `js/ts.tsdk.path` there and remove the local launcher.

- **VS Code and Cursor:** install the recommended TypeScript 7 native preview and Oxc extensions. The workspace
  settings enable the native TypeScript server and point it at `.vscode/tsrs/tsgo`, a launcher for the pinned
  `node_modules/.bin/tsrs`. The Oxc extension reads the cached type-aware backend from `oxc.path.tsgolint`.
- **Zed:** install the TypeScript Language Server (`tsgo`) and Oxc extensions. `.zed/settings.json` starts `tsrs` for
  TypeScript, TSX and JavaScript and runs oxlint alongside it. Zed's oxlint server reads `OXLINT_TSGOLINT_PATH` from
  the environment, so start Zed from a shell after `export OXLINT_TSGOLINT_PATH=$(bun scripts/tsrs-lint.ts)`.
- **Neovim 0.11+:** use this project-root snippet and disable other TypeScript servers for these buffers:

  ```lua
  local function local_bin(name, args)
    return function(dispatchers, config)
      local cmd = vim.list_extend({ config.root_dir .. '/node_modules/.bin/' .. name }, args)
      return vim.lsp.rpc.start(cmd, dispatchers, { cwd = config.root_dir })
    end
  end
  local filetypes = { 'typescript', 'typescriptreact', 'javascript', 'javascriptreact' }
  vim.lsp.config('tsrs', { cmd = local_bin('tsrs', { '--lsp', '--stdio' }), filetypes = filetypes, root_markers = { 'bun.lock' } })
  vim.lsp.config('oxlint', { cmd = local_bin('oxlint', { '--lsp' }), filetypes = filetypes, root_markers = { 'bun.lock' } })
  vim.lsp.enable({ 'tsrs', 'oxlint' })
  ```

  Start Neovim after `export OXLINT_TSGOLINT_PATH=$(bun scripts/tsrs-lint.ts)` so oxlint uses the verified backend.

The lint backend is downloaded and verified by `bun scripts/tsrs-lint.ts` into
`~/.cache/tsrs-lint/<release-tag>/tsrs-lint`. `bun run lint` invokes oxlint through this fetcher, and there is no
fallback to the removed `oxlint-tsgolint` package. The pin and checksums are in `scripts/tsrs-lint.ts`.
If `XDG_CACHE_HOME` is set, the fetcher uses that cache instead; update VS Code/Cursor's `oxc.path.tsgolint` to the
printed path. `.oxlintrc.json` enables type-aware lint for both CLI and editors, including the web's Foldkit plugin.

The 0.2.2 effect-tsrs compiler was measured against 0.2.0 across all nine projects. It did not produce identical
diagnostics (it drops advisory findings in the root and Worker projects), so this repository remains on 0.2.0. The
current `scripts/typecheck.ts` therefore keeps its existing TypeScript diagnostics behavior; a seeded TS2322 fails it.
