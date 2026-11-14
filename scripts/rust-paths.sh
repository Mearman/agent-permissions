#!/bin/sh
# The one definition of which changed paths matter to the Rust side, for the pre-push hook. Reads file paths on stdin, one per line, and exits 0 when any of them matches what the Rust checks cover: the Rust workspace and its toolchain pin, the conformance corpus the native harness reads, the scripts that run or guard the checks, and the workflows and hook that run them.
set -eu

grep -Eq "^(rust/|conformance/|scripts/|\\.github/workflows/(ci|advisories)\\.yml\$|\\.husky/pre-push\$)"
