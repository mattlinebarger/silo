# Authentication Debugging Guide

## Overview

Comprehensive logging has been added to Silo to help diagnose Google account login issues, particularly for work accounts that may use SSO providers like Microsoft Entra, Okta, or Duo.

## What Was Added

### 1. Logging Utility
A new `authLog()` function logs authentication-related events with timestamps and categories:
- **AUTH-FLOW**: Login flow detection and session sync
- **NAVIGATION**: URL navigation attempts and redirects
- **URL-CHECK**: Internal/external URL classification
- **SESSION**: Session partition and cookie information
- **WINDOW-OPEN**: New window/popup requests
- **PROFILE**: Profile switching and view recreation
- **VIEW**: View switching and loading
- **WINDOW**: Create window operations

### 2. Navigation Event Logging
All navigation events are now logged:
- `will-navigate`: When a view attempts to navigate to a new URL
- `did-start-loading`: When a page starts loading
- `did-finish-load`: When a page finishes loading

### 3. Authentication Flow Tracking
The login flow is tracked through these states:
- Detection of `accounts.google.com` pages
- SSO provider redirects (Okta, Microsoft, Duo, etc.)
- Return to Google app after authentication
- Session sync triggering

### 4. Session Information
Logs partition names and Google cookies:
- Profile partition being used
- Number of cookies stored
- Cookie names (not values, for privacy)

## How to Use

### Running the App with Logging

The logging is **always enabled** by default for debugging. To run the app:

```bash
npm start
```

### What to Look For

#### Successful Login Flow
A successful work account login should show:
1. Initial view load
2. Redirect to `accounts.google.com`
3. Possibly redirect to SSO provider (e.g., `login.microsoftonline.com`)
4. Return to Google app (e.g., `mail.google.com`)
5. Session sync triggered
6. Cookies stored

Example log sequence:
```
[AUTH-VIEW-LOAD] Loading view "mail" with URL: https://mail.google.com
[AUTH-NAVIGATION] View "mail" will-navigate to: https://accounts.google.com/...
[AUTH-AUTH-FLOW] View "mail" did-start-loading: https://accounts.google.com/...
[AUTH-AUTH-FLOW] Detected Google accounts page, setting wasOnAccountsPage=true
[AUTH-URL-CHECK] URL is Google domain (internal): login.microsoftonline.com
[AUTH-NAVIGATION] Internal URL navigation allowed: https://login.microsoftonline.com/...
[AUTH-AUTH-FLOW] View "mail" did-finish-load: https://mail.google.com/...
[AUTH-AUTH-FLOW] Login detected! Scheduling session sync for view "mail"
[AUTH-SESSION] View "mail" has 15 Google cookies after page load
```

#### Common Issues to Identify

**Issue 1: External URL Being Blocked**
```
[AUTH-URL-CHECK] URL internal check result for some-sso-provider.com: false
[AUTH-NAVIGATION] External URL blocked, opening in browser: https://some-sso-provider.com
```
**Solution**: Add the domain to `INTERNAL_DOMAINS` array in [main.js](src/main/main.js)

**Issue 2: Authentication Intermediate Page Prompting User**
```
[AUTH-NAVIGATION] Different Google app, prompting user for: https://accounts.google.com/a/domain/acs
```
**Solution**: This is fixed in the current version. The `/acs`, `/ServiceLogin`, and `/CheckCookie` paths are now excluded from prompting as they're part of the authentication flow.

**Issue 3: Navigation Loop**
```
[AUTH-AUTH-FLOW] View "mail" did-finish-load: https://accounts.google.com/...
[AUTH-AUTH-FLOW] View "mail" did-finish-load: https://accounts.google.com/...
[AUTH-AUTH-FLOW] View "mail" did-finish-load: https://accounts.google.com/...
```
**Solution**: The auth flow may be stuck. Check if cookies are being blocked or if the SSO flow isn't completing.

**Issue 4: No Cookies Stored**
```
[AUTH-SESSION] View "mail" has 0 Google cookies after page load
```
**Solution**: Session storage may be failing. Check if the partition is correct and if there are filesystem permission issues.

**Issue 5: Session Sync Not Triggered**
```
[AUTH-AUTH-FLOW] Page analysis for "mail" {
  isOnGoogleApp: true,
  isIntermediatePage: false,
  shouldTriggerRestart: false
}
```
**Solution**: The `wasOnAccountsPage` flag may not be set correctly. Check if the auth flow went through `accounts.google.com` or directly through an SSO provider.

## Viewing Console Output

### macOS (recommended)
Open Console.app and filter by "Electron" or "Silo" to see all log output.

### Terminal
Run the app from terminal to see logs directly:
```bash
npm start 2>&1 | tee silo-debug.log
```

This will display logs and save them to `silo-debug.log` for later review.

### VS Code Integrated Terminal
If running from VS Code, all logs will appear in the integrated terminal.

## Collecting Logs for Support

If you need to share logs for troubleshooting:

1. Run the app from terminal with output capture:
   ```bash
   npm start 2>&1 | tee auth-issue-$(date +%Y%m%d-%H%M%S).log
   ```

2. Attempt to log in to your work account

3. After the issue occurs, stop the app (Cmd+Q)

4. Review the log file and redact any sensitive information:
   - Email addresses
   - User names
   - Any authentication tokens (though these shouldn't be logged)

5. Share the redacted log file

## Adding New SSO Providers

If your work account uses an SSO provider not in the `INTERNAL_DOMAINS` list:

1. Note the domain from the logs (look for "External URL blocked" messages)

2. Add it to the `INTERNAL_DOMAINS` array in [main.js](src/main/main.js):
   ```javascript
   const INTERNAL_DOMAINS = [
     "login.microsoftonline.com",  // Microsoft Entra
     "okta.com",                    // Okta
     "your-sso-domain.com",         // Add your domain here
     // ... other domains
   ];
   ```

3. Restart the app and try logging in again

## Disabling Logging

If you want to disable authentication logging (not recommended while debugging):

Edit [main.js](src/main/main.js) and change:
```javascript
const AUTH_LOG_ENABLED = process.env.LOG_AUTH === 'true' || true;
```
to:
```javascript
const AUTH_LOG_ENABLED = process.env.LOG_AUTH === 'true' || false;
```

Then set the environment variable to enable logging only when needed:
```bash
LOG_AUTH=true npm start
```

## Next Steps

1. **Run the app** and attempt to log in to your work account
2. **Review the logs** to identify where the authentication flow fails
3. **Check for blocked URLs** that may need to be added to `INTERNAL_DOMAINS`
4. **Look for cookie/session issues** that might prevent persistent login
5. **Share logs** (with sensitive info redacted) if you need additional support

## Technical Details

### Session Partitioning
- Default profile uses the default Electron session (no partition)
- Custom profiles use `persist:profile-{id}` partitions
- Each partition maintains its own cookies and storage

### Authentication Flow Detection
The app detects successful login by:
1. Tracking when the user is on `accounts.google.com`
2. Detecting navigation back to a Google app domain
3. Filtering out intermediate SSO pages (e.g., `/a/domain/acs`)
4. Triggering a window restart to sync sessions across all views

### URL Filtering
URLs are classified as:
- **Google domains**: Always internal (`.google.com`)
- **Internal domains**: Listed in `INTERNAL_DOMAINS` (SSO providers, etc.)
- **External domains**: Opened in default browser

**Authentication Intermediate Pages**: Certain paths are excluded from the "Google app" check and allowed to navigate automatically without prompting:
- `/acs` - Assertion Consumer Service (SAML endpoint)
- `/ServiceLogin` - Google's login service
- `/CheckCookie` - Cookie verification pages

These pages are part of the SSO authentication flow and should not interrupt the user with prompts.

### Window Open Handling
New windows/popups are:
- **Google app URLs**: User is prompted to choose between new window or browser
- **Internal URLs**: Allowed to open within the app
- **External URLs**: Automatically opened in default browser
