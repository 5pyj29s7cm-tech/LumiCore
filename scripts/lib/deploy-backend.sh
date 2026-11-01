#!/usr/bin/env bash
# This file defines a checked copy operation; sourcing it does not install anything.
install_backend_resources() {
  local source="$1" destination="$2" required
  for required in entry.cjs server.mjs runtime-meta.json node; do
    if [ ! -s "$source/$required" ]; then
      printf 'Missing required packaged backend file: %s\n' "$required" >&2
      return 1
    fi
  done
  sudo mkdir -p "$destination" || return $?
  sudo cp -R "$source"/. "$destination"/ || return $?
  for required in entry.cjs server.mjs runtime-meta.json node; do
    if [ ! -s "$destination/$required" ]; then
      printf 'Installed backend file is missing: %s\n' "$required" >&2
      return 1
    fi
  done
  sudo chmod +x "$destination/node" || return $?
}
