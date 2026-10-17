#!/bin/sh
# Registers the .rs file type and its icon for the current user (GNOME, KDE, ...).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.local/share/mime/packages"
cp "$here/realot-project.xml" "$HOME/.local/share/mime/packages/"
update-mime-database "$HOME/.local/share/mime"
for size in 48 128 256 512; do
  xdg-icon-resource install --context mimetypes --size "$size" \
    "$here/../icons/rs-file-$size.png" application-x-realot-project
done
echo "Done. You may need to restart your file manager to see the icon."
