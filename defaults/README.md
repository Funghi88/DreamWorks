# Optional bundled settings (Electron pack)

`settings.json` in this folder is **copied into the app bundle** (`Resources/defaults/`) when you run `npm run pack` / `electron-builder`.

On **first launch**, if the user has no `settings.json` in their profile yet, DreamWorks will **copy this file** into:

`~/Library/Application Support/DreamWorks/settings.json` (macOS)

So you can ship a **default whiteboard + teleprompter** snapshot for local testing.

1. Copy your current profile into this folder **before packing**:

   ```bash
   npm run copy-settings-to-defaults
   ```

   Or manually copy `settings.json` from your app support folder (see main README).

2. Run `npm run pack` as usual.

3. Remove or rename `defaults/settings.json` if you do **not** want it in the next build.

**Note:** Do not commit large personal files if you use a public repo; add `defaults/settings.json` to `.gitignore` locally if needed.
