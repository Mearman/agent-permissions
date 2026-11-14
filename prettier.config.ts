export default {
  singleQuote: false,
  overrides: [
    // The shared conformance runner is held to a byte cap, so it is formatted wide.
    { files: "conformance/runner/*.mjs", options: { printWidth: 150 } },
  ],
};
