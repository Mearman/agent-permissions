export default {
  "src/**/*.{ts,tsx}": "eslint --cache --fix",
  ".github/**/*.ts": "eslint --cache --fix",
  "{README,SECURITY,CONTRIBUTING}.md": "prettier --write",
  "{package,tsconfig,server}.json": "prettier --write",
  "pnpm-workspace.yaml": "prettier --write",
  "spec/examples/*.json": "prettier --write",
  ".claude-plugin/plugin.json": "prettier --write",
  ".github/workflows/*.yml": "prettier --write",
};
