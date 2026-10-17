# Showing the Realot icon on `.rs` project files

A `.rs` file is a ZIP archive with Realot's own extension. Which icon a file
shows is decided by your operating system from the extension, so a web app
can't change it directly. There are two ways to get the Realot icon:

## 1. Install Realot as an app (recommended, nothing to configure)

`manifest.webmanifest` declares a **file handler** for `.rs` with the
document-style Realot icon (`icons/rs-file-*.png`). When someone installs
Realot from Chrome or Edge ("Install app"), the browser registers the type
with the OS:

- `.rs` files get the Realot file icon (Windows, ChromeOS and Linux Chromium
  browsers; support elsewhere depends on the browser version).
- Double-clicking a `.rs` file, or "Open with → Realot", opens the editor
  with that project loaded. The file is opened as an unsaved session; use
  File → Save Project to write changes back out.

macOS and mobile browsers do not currently show web-app file icons; there the
file keeps a generic icon. That is an OS limitation, not something the app
can fix.

## 2. Manual association (optional, untested)

For machines where the app is not installed. Neither file below opens
Realot; they only set the icon and file type name.

- **Windows:** edit the path inside `realot-windows.reg`, double-click it,
  then restart Explorer. Uses `realot-project.ico`.
- **Linux (GNOME/KDE):** run `./install-linux.sh`. Registers the
  `application/x-realot-project` type and its icon.

I could not test these two on real Windows/Linux desktops here; treat them as
a starting point.
