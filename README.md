# Silo

<p align="center">
  <img src="assets/readme_header.png" alt="Silo Header" />
</p>

Silo is a lightweight Electron desktop app that brings Google Workspace tools into a focused, native-feeling experience on macOS.

It is not trying to replace your browser. It is trying to reduce friction.

Silo keeps Gmail, Calendar, Drive, Keep, Tasks, Contacts, and Gemini one click away in a single app, with fast switching, a minimal sidebar, and sane defaults that stay out of your way.

This started as a personal project to scratch an itch and learn more about Electron. It may eventually become something more.

## What Silo Is

Silo is:

- A macOS desktop wrapper for Google Workspace and Gemini
- Built with Electron
- Focused on speed, simplicity, and keyboard-friendly workflows
- Opinionated about UI, but intentionally limited in scope

It uses BrowserViews instead of tabs, so each Google app feels persistent rather than disposable.

## What Silo Is Not

Silo is not:

- A full Google Workspace client
- A replacement for native Google apps
- A polished, supported commercial product (yet)

Think of it as a sharp tool, not a Swiss Army knife.

## Features

- **Multiple Profile Support**
  - Switch between multiple Google accounts with isolated sessions
  - Custom profile pictures via upload
  - Profile management UI with easy switching
  - Session isolation using Electron's partition feature
- **Quick App Switching**
  - Fast toggling between Gmail, Calendar, Drive, Keep, Tasks, Contacts, and Gemini
  - Separate persistent views for each app
- **Additional Features**
  - Minimal sidebar with Material-style icons and custom icons where needed
  - Native macOS menus and keyboard shortcuts
  - Custom settings panel
  - No tracking, no analytics, no account meddling

## Tech Stack

- Electron
- Node.js
- HTML, CSS, vanilla JavaScript
- Material Symbols plus custom icons

## Keyboard Shortcuts

- `Cmd+1` - Gmail
- `Cmd+2` - Calendar
- `Cmd+3` - Drive
- `Cmd+4` - Gemini
- `Cmd+5` - Keep
- `Cmd+6` - Tasks
- `Cmd+7` - Contacts
- `Cmd+N` - New email
- `Cmd+,` - Settings (Profile Management)
- `Cmd+R` - Reload current view

## Managing Profiles

Silo supports multiple Google accounts through profiles:

1. **Access Settings**: Click your profile avatar at the bottom of the sidebar, or press `Cmd+,`
2. **Create Profile**: Click "New Profile" and give it a name
3. **Upload Picture**: Optionally upload a custom profile picture (or use the default account icon)
4. **Switch Profiles**: Click any profile to switch - the app will restart with that profile's session
5. **Edit/Delete**: Use the edit and delete buttons on non-default profiles

Each profile maintains its own:
- Google account sessions
- Login state
- Cookies and local storage

The default profile is your initial setup and cannot be deleted.

## Development Setup

Clone the repo and install dependencies:

```
git clone https://github.com/your-username/silo.git
cd silo
npm install
```

Run the app in development mode:

```
npRead [CONTRIBUTING.md](CONTRIBUTING.md) for Git workflow and branching strategy
- Open an issue first to discuss ideas
- Keep changes focused and small
- Prefer clarity over cleverness
- Follow the conventional commit format: `type(scope): description`

This project values maintainability and restraint.

See [GIT_QUICK_REFERENCE.md](GIT_QUICK_REFERENCE.md) for quick Git commands
## Platform Support

Currently tested on:

- macOS

Other platforms may work, but are not actively supported or tested.

## Status

This project is actively evolving and still rough around the edges. Expect:

- Incomplete features
- UI tweaks
- Breaking changes
- Occasional questionable decisions made late at night

That said, it is already useful in daily work.

## Contributing

Contributions are welcome, but expectations are intentionally modest.

If you want to contribute:

- Open an issue first to discuss ideas
- Keep changes focused and small
- Prefer clarity over cleverness

This project values maintainability and restraint.

## License

MIT License. Do what you want, just do not be weird about it.
