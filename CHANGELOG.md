# Changelog

All notable changes to Silo will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Custom profile picture upload functionality
- Material Icons account_circle as default avatar
- Clickable profile avatar in sidebar to access settings
- Git workflow and branching documentation

### Changed
- Profile system now uses local file uploads instead of Google profile pictures
- Removed color selection for profiles
- Profile manager stores avatarPath instead of color and avatarUrl

### Fixed
- MaxListenersExceededWarning when switching profiles
- Event listener cleanup on window close

### Removed
- Google profile picture extraction/scraping code
- Color picker UI from profile settings
- Automatic profile picture fetching on login

## [1.0.0] - 2025-12-29

### Added
- Initial release
- BrowserView-based architecture for Google Workspace apps
- Support for Gmail, Calendar, Drive, Gemini, Keep, Tasks, Contacts
- 60px fixed sidebar with Material Design icons
- Multi-profile support with session isolation
- Profile management UI
- Keyboard shortcuts (Cmd+1-7 for app switching)
- Settings view for profile management
- External link handling (opens in default browser)
- macOS-specific features (dock badge for unread count)
- Native macOS menu integration
- Light and dark mode support

### Technical Details
- Electron 39.2.3
- electron-store for persistent profile data
- CommonJS module system
- Security: Context isolation, URL whitelisting
- BrowserView session partitioning per profile

[Unreleased]: https://github.com/mattlinebarger/silo/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/mattlinebarger/silo/releases/tag/v1.0.0
