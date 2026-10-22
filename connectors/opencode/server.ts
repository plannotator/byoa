// The server entry. OpenCode loads a plugin folder by path as `<folder>/server`
// and `<folder>/tui` (package.json `exports` count only for npm installs), so
// both entries sit here at the root.
export { default } from "./src/server.ts";
