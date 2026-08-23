export default {
  // One gate: eslint --fix formats and fixes every file type it covers (TypeScript directly, and JSON/Markdown/YAML through the prettier plugin), matching the _lint task exactly.
  '**/*.{ts,tsx,md,json,yaml,yml}': 'eslint --cache --fix',
};
