const {
  app,
  BrowserWindow,
  WebContentsView,
  Menu,
  MenuItem,
  clipboard,
  ipcMain,
  shell,
  nativeImage,
  dialog,
} = require("electron");
const path = require("path");
const ProfileManager = require("./profile-manager");

// Global state: single window with multiple persistent WebContentsViews
// Each Google app lives in its own WebContentsView (not tab/separate window)
// Views persist in memory even when hidden - maintains state between switches
let mainWindow = null;
let views = {}; // Registry of all WebContentsViews keyed by name (mail, calendar, etc.)
let currentView = "mail"; // Tracks which content view is currently visible
let profileManager = null; // Profile manager instance
let lastSessionSyncAt = 0; // Debounce so reloaded views can't re-trigger a sync loop

const isMac = process.platform === "darwin";

// Google refuses sign-in from embedded browsers ("Couldn't sign you in /
// browser doesn't support JavaScript") based on user-agent sniffing.
// Strip the Electron and app tokens so we present as plain Chrome.
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/i, "")
  .replace(/\ssilo\/\S+/i, "");

const VIEW_URLS = {
  mail: "https://mail.google.com",
  calendar: "https://calendar.google.com",
  drive: "https://drive.google.com",
  gemini: "https://gemini.google.com",
  keep: "https://keep.google.com",
  tasks: "https://tasks.google.com",
  contacts: "https://contacts.google.com",
  settings: `file://${path.join(__dirname, "../renderer/settings.html")}`,
};

// Load menu icons as templates for native macOS appearance
// Template images automatically adapt to light/dark mode and menu state
function loadMenuIcon(name) {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, "../assets/menu", `${name}.png`)
  );
  icon.setTemplateImage(true); // Enables automatic color adaptation
  return icon;
}

const menuIcons = {
  settings: loadMenuIcon("settings"),
  reload: loadMenuIcon("reload"),
};

// Security: whitelist of allowed domains for logging in/SSO
// Any navigation/window.open to external URLs opens in default browser
// Update this list when adding new auth providers
const INTERNAL_DOMAINS = [
  "login.microsoftonline.com", // Microsoft Entra
  "microsoft.com",             // Microsoft services
  "okta.com",                  // Okta authentication
  "oktacdn.com",               // Okta CDN resources
  "oktapreview.com",           // Okta preview environments
  "duofederal.com",            // Duo Federal authentication
  "duosecurity.com",           // Duo auth and static assets
  "msauth.net",                // Microsoft authentication
  "live.com",                  // Microsoft Live services
  "microsoftonline.com",       // Microsoft Online services
  "windows.net",               // Azure services
  "sentry.io",                 // Sentry error tracking
];

// Google app domains that should prompt user for open location
const GOOGLE_APP_DOMAINS = [
  "mail.google.com",
  "calendar.google.com",
  "drive.google.com",
  "docs.google.com",
  "sheets.google.com",
  "slides.google.com",
  "gemini.google.com",
  "keep.google.com",
  "tasks.google.com",
  "contacts.google.com",
  "accounts.google.com",
  "myaccount.google.com",
];

// Strict domain match: exact hostname or a true subdomain.
// Prevents spoofing like "evilmicrosoft.com" matching "microsoft.com"
function matchesDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith("." + domain);
}

// Check if URL is a Google app domain that should prompt user
// Also handles Google redirect URLs (www.google.com/url?q=...)
// Excludes authentication intermediate pages (e.g., /a/domain/acs)
function isGoogleAppUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    const pathname = urlObj.pathname;

    // Exclude authentication intermediate pages (Assertion Consumer Service)
    // These are part of SSO flow and should navigate automatically
    if (pathname.includes('/acs') || pathname.includes('/ServiceLogin') || pathname.includes('/CheckCookie')) {
      return false;
    }

    // Handle Google redirect URLs - check the actual destination
    if ((hostname === 'www.google.com' || hostname === 'google.com') && urlObj.pathname === '/url') {
      const actualUrl = urlObj.searchParams.get('q');
      if (actualUrl) {
        return isGoogleAppUrl(actualUrl);
      }
    }

    return GOOGLE_APP_DOMAINS.some((domain) => hostname === domain);
  } catch {
    return false;
  }
}

// Extract the actual URL from a Google redirect URL, or return the original
function resolveGoogleRedirect(url) {
  try {
    const urlObj = new URL(url);
    if ((urlObj.hostname === 'www.google.com' || urlObj.hostname === 'google.com') && urlObj.pathname === '/url') {
      const actualUrl = urlObj.searchParams.get('q');
      if (actualUrl) {
        return actualUrl;
      }
    }
  } catch {}
  return url;
}

// Show dialog asking user where to open Google app URL
async function promptOpenLocation(url) {
  // Resolve Google redirect to show/use the actual destination
  const resolvedUrl = resolveGoogleRedirect(url);

  const options = {
    type: 'question',
    buttons: ['New Window', 'Default Browser', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Open Link',
    message: 'Where would you like to open this link?',
    detail: resolvedUrl,
  };

  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);

  if (result.response === 0) {
    // New Window
    openCreateWindow(resolvedUrl);
  } else if (result.response === 1) {
    // Default Browser
    shell.openExternal(resolvedUrl);
  }
  // Cancel does nothing
}

function isInternalUrl(url) {
  try {
    const urlObj = new URL(url);
    const { hostname, searchParams } = urlObj;

    // Handle Google's redirect URLs (e.g., google.com/url?q=actual-url)
    // Extract the real destination URL and check that instead
    if (matchesDomain(hostname, 'google.com') && urlObj.pathname === '/url') {
      const actualUrl = searchParams.get('q');
      if (actualUrl) {
        // Recursively check the actual destination URL
        return isInternalUrl(actualUrl);
      }
    }

    // Allow google.com domains for auth flows and app navigation
    if (matchesDomain(hostname, 'google.com')) {
      return true;
    }

    return INTERNAL_DOMAINS.some((domain) => matchesDomain(hostname, domain));
  } catch {
    return false;
  }
}

// IPC: Update macOS dock badge with unread count from Gmail
// Triggered by preload script watching Gmail's document title
ipcMain.on("unread-count", (event, count) => {
  if (isMac && app.dock) {
    const n = Number(count);
    app.dock.setBadge(Number.isFinite(n) && n > 0 ? String(n) : "");
  }
});

// Profile IPC handlers
ipcMain.handle("profiles:get-all", () => {
  return {
    profiles: profileManager.getProfiles(),
    activeProfileId: profileManager.getActiveProfile().id,
  };
});

// Only accept known profile fields from the renderer
function sanitizeProfileInput(data) {
  const allowed = {};
  if (typeof data?.name === "string") allowed.name = data.name;
  if (typeof data?.avatarPath === "string" || data?.avatarPath === null) {
    allowed.avatarPath = data.avatarPath;
  }
  if (Array.isArray(data?.enabledApps)) {
    allowed.enabledApps = data.enabledApps.filter(
      (a) => typeof a === "string" && a in VIEW_URLS && a !== "settings"
    );
  }
  return allowed;
}

ipcMain.handle("profiles:create", (event, data) => {
  return profileManager.createProfile(sanitizeProfileInput(data));
});

ipcMain.handle("profiles:update", (event, { id, updates }) => {
  return profileManager.updateProfile(id, sanitizeProfileInput(updates));
});

ipcMain.handle("profiles:delete", (event, id) => {
  return profileManager.deleteProfile(id);
});

ipcMain.handle("profiles:switch", async (event, id) => {
  profileManager.setActiveProfile(id);
  // Recreate all views with new profile partition, show mail after switch
  recreateViews('mail');
  return true;
});

ipcMain.handle("profiles:select-avatar", async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }
    ],
    title: 'Select Profile Picture'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// Sidebar profile IPC handlers
ipcMain.handle("sidebar-get-active-profile", () => {
  return profileManager.getActiveProfile();
});

function notifySidebarProfileUpdate() {
  if (views.sidebar && !views.sidebar.webContents.isDestroyed()) {
    const activeProfile = profileManager.getActiveProfile();
    views.sidebar.webContents.send("sidebar-profile-update", activeProfile);
  }
}

// Shared link policy for windows the app opens (popups allowed by the
// window-open handler and compose/create windows). Without these guards a
// popup could be navigated anywhere while still looking like part of the app.
function attachWindowGuards(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isGoogleAppUrl(url)) {
      promptOpenLocation(url);
      return { action: "deny" };
    }
    if (isInternalUrl(url)) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  win.webContents.on("did-create-window", (newWindow, details) => {
    if (!isInternalUrl(details.url)) {
      newWindow.close();
      shell.openExternal(details.url);
      return;
    }
    attachWindowGuards(newWindow);
  });
}

// Session sync: when a login completes in one view, reload the other views so
// they pick up the fresh cookies from the shared partition. Replaces the old
// approach of destroying and recreating the entire window on a timer.
function syncSessionsFrom(sourceKey) {
  const now = Date.now();
  // Reloaded views can briefly pass through accounts.google.com themselves;
  // the cooldown prevents them from re-triggering a sync loop
  if (now - lastSessionSyncAt < 30000) return;
  lastSessionSyncAt = now;

  console.log(`[Session Sync] Login detected in "${sourceKey}", reloading other views`);

  for (const key of Object.keys(VIEW_URLS)) {
    if (key === sourceKey || key === "settings") continue;
    const view = views[key];
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.loadURL(VIEW_URLS[key]);
    }
  }
}

function createContentView(key, partition = null) {
  const webPreferences = {
    preload: path.join(__dirname, "../preload/preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
  };

  // Add session partition if provided (for profile isolation)
  if (partition) {
    webPreferences.partition = partition;
  }

  const view = new WebContentsView({
    webPreferences,
  });

  // Security: Intercept window.open() calls
  // Google app URLs prompt user, other internal URLs open in new window, external opens in browser
  view.webContents.setWindowOpenHandler(({ url }) => {
    // Google app URLs prompt user for choice
    if (isGoogleAppUrl(url)) {
      promptOpenLocation(url);
      return { action: "deny" };
    }

    // Other internal URLs (SSO, etc.) are allowed to open
    if (isInternalUrl(url)) {
      return { action: "allow" };
    }

    shell.openExternal(url);
    return { action: "deny" };
  });

  // Handle new windows that were allowed to open
  view.webContents.on("did-create-window", (newWindow, details) => {
    // If a Google app URL somehow got through, close it and prompt
    if (isGoogleAppUrl(details.url)) {
      newWindow.close();
      promptOpenLocation(details.url);
      return;
    }

    // External URLs should open in browser
    if (!isInternalUrl(details.url)) {
      newWindow.close();
      shell.openExternal(details.url);
      return;
    }

    // Allowed popups (SSO windows, etc.) get the same link policy
    attachWindowGuards(newWindow);
  });

  // Right-click context menu
  view.webContents.on('context-menu', (event, params) => {
    const menu = new Menu();

    // Add link options if right-clicked on a link
    if (params.linkURL) {
      if (isGoogleAppUrl(params.linkURL)) {
        // Google app URLs get choice of new window or browser
        menu.append(new MenuItem({
          label: 'Open in New Window',
          click: () => openCreateWindow(params.linkURL)
        }));
        menu.append(new MenuItem({
          label: 'Open in Browser',
          click: () => shell.openExternal(params.linkURL)
        }));
      } else if (isInternalUrl(params.linkURL)) {
        menu.append(new MenuItem({
          label: 'Open Link',
          click: () => view.webContents.loadURL(params.linkURL)
        }));
      } else {
        menu.append(new MenuItem({
          label: 'Open Link in Browser',
          click: () => shell.openExternal(params.linkURL)
        }));
      }

      menu.append(new MenuItem({
        label: 'Copy Link',
        click: () => clipboard.writeText(params.linkURL)
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    // Text selection options
    if (params.selectionText) {
      menu.append(new MenuItem({
        label: 'Copy',
        role: 'copy'
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    // Editable field options
    if (params.isEditable) {
      menu.append(new MenuItem({ label: 'Cut', role: 'cut' }));
      menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
      menu.append(new MenuItem({ label: 'Paste', role: 'paste' }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    // Always show navigation options
    menu.append(new MenuItem({
      label: 'Back',
      enabled: view.webContents.navigationHistory.canGoBack(),
      click: () => view.webContents.navigationHistory.goBack()
    }));
    menu.append(new MenuItem({
      label: 'Forward',
      enabled: view.webContents.navigationHistory.canGoForward(),
      click: () => view.webContents.navigationHistory.goForward()
    }));
    menu.append(new MenuItem({
      label: 'Reload',
      click: () => view.webContents.reload()
    }));

    menu.popup();
  });

  // Security: Intercept navigation attempts (clicking links, redirects)
  // Google app URLs prompt user, external URLs open in default browser
  view.webContents.on("will-navigate", (event, url) => {
    // Google app URLs should prompt user (except when navigating within the same app)
    if (isGoogleAppUrl(url)) {
      // Check if we're already on this Google app - allow navigation within same app
      try {
        const currentHost = new URL(view.webContents.getURL()).hostname;
        const targetHost = new URL(url).hostname;
        if (currentHost === targetHost) {
          return; // Same app, allow navigation
        }
      } catch {}

      // Different Google app - prompt user
      event.preventDefault();
      promptOpenLocation(url);
      return;
    }

    if (isInternalUrl(url)) {
      return;
    }

    event.preventDefault();
    shell.openExternal(url);
  });

  // Detect login completion: user visits accounts.google.com (login form),
  // then lands on a real Google app page. Server-side redirects during a
  // normal signed-in load don't fire did-start-loading on the accounts URL,
  // so this only triggers on actual interactive logins.
  let wasOnAccountsPage = false;

  view.webContents.on("did-start-loading", () => {
    try {
      const url = view.webContents.getURL();
      if (url && url.includes("accounts.google.com")) {
        wasOnAccountsPage = true;
      } else if (url && wasOnAccountsPage && !isInternalUrl(url)) {
        // Reset if we navigate to an external domain (like Okta)
        // This prevents triggering sync after external auth flows
        wasOnAccountsPage = false;
      }
    } catch (e) {
      // Ignore errors when getting URL
    }
  });

  view.webContents.on("did-finish-load", () => {
    try {
      const url = view.webContents.getURL();
      if (!url) return;

      const { hostname, pathname } = new URL(url);

      // Check if we're on an actual Google app page (not just accounts or generic google.com)
      const isOnGoogleApp = Object.keys(VIEW_URLS)
        .filter((k) => k !== "settings")
        .some((k) => hostname === new URL(VIEW_URLS[k]).hostname);

      // Skip intermediate pages like /a/domain/acs (Assertion Consumer Service)
      // These are part of the SSO flow, not the final destination
      const isIntermediatePage = (
        pathname.includes('/acs') ||
        pathname.includes('/a/') ||
        hostname === 'www.google.com'
      );

      if (wasOnAccountsPage && isOnGoogleApp && !isIntermediatePage) {
        wasOnAccountsPage = false;
        syncSessionsFrom(key);
      }
    } catch (e) {
      console.error("Error in session sync:", e);
    }
  });

  view.webContents.loadURL(VIEW_URLS[key]);
  return view;
}

function createSettingsView() {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "../preload/settings-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  view.webContents.loadURL(VIEW_URLS.settings);
  return view;
}

// Layout: Position views using explicit bounds (CSS doesn't work on WebContentsViews)
// Sidebar: Fixed 60px width at x:0
// Content: Fills remaining width starting at x:60
// Called on window resize to maintain layout
function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const bounds = mainWindow.getContentBounds();
  const sidebarWidth = 60;

  views.sidebar.setBounds({
    x: 0,
    y: 0,
    width: sidebarWidth,
    height: bounds.height,
  });

  const content = views[currentView];
  content.setBounds({
    x: sidebarWidth,
    y: 0,
    width: bounds.width - sidebarWidth,
    height: bounds.height,
  });
}

// Recreate all views with new profile partition
// Called when switching profiles to ensure complete session isolation
// targetViewOverride: optional view to show after recreation (default: current view)
function recreateViews(targetViewOverride = null) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const previousView = currentView;

  // Remove all content views from window and close them to clear session
  for (const key of Object.keys(VIEW_URLS)) {
    if (views[key]) {
      try {
        mainWindow.contentView.removeChildView(views[key]);
        views[key].webContents.close();
      } catch (e) {
        console.error(`Error closing view ${key}:`, e);
      }
    }
  }

  // Get new partition for active profile
  const activeProfile = profileManager.getActiveProfile();
  const partition = profileManager.getPartitionName(activeProfile.id);
  const enabledApps = activeProfile.enabledApps || ['mail', 'calendar', 'drive', 'gemini', 'keep', 'tasks', 'contacts'];

  // Recreate all views with new partition
  for (const key of Object.keys(VIEW_URLS)) {
    views[key] = key === 'settings' ? createSettingsView() : createContentView(key, partition);
  }

  // Check if current view is enabled, if not switch to first enabled app
  // Use override if provided (e.g., when switching profiles)
  let targetView = targetViewOverride || previousView;
  if (targetView !== 'settings' && !enabledApps.includes(targetView)) {
    console.log(`View ${targetView} is disabled, switching to ${enabledApps[0] || 'mail'}`);
    targetView = enabledApps[0] || 'mail';
  }

  // Re-show target view (sidebar added last stays on top)
  mainWindow.contentView.addChildView(views[targetView]);
  mainWindow.contentView.addChildView(views.sidebar);
  currentView = targetView;

  layoutViews();

  // Update sidebar with new profile and active view
  notifySidebarProfileUpdate();
  views.sidebar.webContents.send("sidebar-set-active", targetView);

  // Refresh menu to update profile checkmarks
  createMenu();
}


// View switching: Remove content views, then re-add target + sidebar
// Order matters: sidebar added last stays on top (z-order)
// Views remain in memory when removed - no state loss
function showView(name) {
  // Reopen the window if it was closed (macOS keeps the app alive)
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }

  // Check if view is enabled (except settings which is always available)
  if (name !== 'settings') {
    const activeProfile = profileManager.getActiveProfile();
    const enabledApps = activeProfile?.enabledApps || ['mail', 'calendar', 'drive', 'gemini', 'keep', 'tasks', 'contacts'];

    if (!enabledApps.includes(name)) {
      console.log(`View ${name} is not enabled, ignoring switch request`);
      return;
    }
  }

  currentView = name;

  // Remove all content views from window (but don't close them)
  for (const key of Object.keys(VIEW_URLS)) {
    if (views[key]) {
      try {
        mainWindow.contentView.removeChildView(views[key]);
      } catch {}
    }
  }

  // Re-add target content view and sidebar
  // Sidebar must be added last to maintain proper z-order
  mainWindow.contentView.addChildView(views[name]);
  mainWindow.contentView.addChildView(views.sidebar);

  views.sidebar.webContents.send("sidebar-set-active", name);
  mainWindow.setTitle("");

  layoutViews();
}

// Open compose/create actions in separate window (not a view)
// Used for: new email, calendar events, docs, etc.
function openCreateWindow(url) {
  // Use same session partition as current profile for consistent login state
  const activeProfile = profileManager.getActiveProfile();
  const partition = profileManager.getPartitionName(activeProfile.id);

  const win = new BrowserWindow({
    width: 900,
    height: 700,
    title: "",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: partition,
    },
  });

  attachWindowGuards(win);
  win.loadURL(url);
  win.focus();
}

function buildProfilesMenu() {
  const profiles = profileManager.getProfiles();
  const activeProfile = profileManager.getActiveProfile();

  const profileItems = profiles.map(profile => ({
    label: profile.name,
    type: 'checkbox',
    checked: profile.id === activeProfile.id,
    click: () => {
      if (profile.id !== activeProfile.id) {
        profileManager.setActiveProfile(profile.id);
        recreateViews();
      }
    },
  }));

  return [
    ...profileItems,
    { type: 'separator' },
    {
      label: 'Manage Profiles...',
      click: () => showView('settings'),
    },
  ];
}

function createMenu() {
  const activeProfile = profileManager.getActiveProfile();
  const enabledApps = activeProfile?.enabledApps || ['mail', 'calendar', 'drive', 'gemini', 'keep', 'tasks', 'contacts'];

  // Map of app keys to menu items with labels and accelerators
  const appMenuItems = {
    mail: { label: "Mail", accelerator: "Cmd+1" },
    calendar: { label: "Calendar", accelerator: "Cmd+2" },
    drive: { label: "Drive", accelerator: "Cmd+3" },
    gemini: { label: "Gemini", accelerator: "Cmd+4" },
    keep: { label: "Keep", accelerator: "Cmd+5" },
    tasks: { label: "Tasks", accelerator: "Cmd+6" },
    contacts: { label: "Contacts", accelerator: "Cmd+7" },
  };

  // Build Switch To submenu with only enabled apps
  const switchToSubmenu = enabledApps
    .filter(app => appMenuItems[app]) // Only include valid app keys
    .map(app => ({
      label: appMenuItems[app].label,
      accelerator: appMenuItems[app].accelerator,
      click: () => showView(app),
    }));

  const template = [
    {
      label: "Silo",
      submenu: [
        {
          role: "about",
        },
        {
          label: "Settings…",
          accelerator: "Cmd+,",
          icon: menuIcons.settings,
          click: () => showView("settings"),
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New",
          submenu: [
            {
              label: "Email",
              accelerator: "Cmd+N",
              click: () =>
                openCreateWindow("https://mail.google.com/mail/?view=cm&fs=1"),
            },
            {
              label: "Calendar Event",
              click: () =>
                openCreateWindow(
                  "https://calendar.google.com/calendar/u/0/r/eventedit"
                ),
            },
            {
              label: "Task",
              click: () =>
                openCreateWindow(
                  "https://calendar.google.com/calendar/u/0/r/tasks"
                ),
            },
            {
              label: "Appointment Schedule",
              click: () =>
                openCreateWindow(
                  "https://calendar.google.com/calendar/u/0/r/appointment"
                ),
            },
            {
              label: "Contact",
              click: () => openCreateWindow("https://contacts.google.com/new"),
            },
            { type: "separator" },
            {
              label: "Google Doc",
              click: () =>
                openCreateWindow("https://docs.google.com/document/create"),
            },
            {
              label: "Google Sheet",
              click: () =>
                openCreateWindow("https://docs.google.com/spreadsheets/create"),
            },
            {
              label: "Google Slide",
              click: () =>
                openCreateWindow("https://docs.google.com/presentation/create"),
            },
          ],
        },
        { type: "separator" },
        {
          label: "Switch To",
          submenu: switchToSubmenu,
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Reload",
          accelerator: "Cmd+R",
          icon: menuIcons.reload,
          click: () => {
            const view = views[currentView];
            if (view) view.webContents.reload();
          },
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      role: "windowMenu",
    },
    {
      label: "Profiles",
      submenu: buildProfilesMenu(),
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 900,
    title: "",
    fullscreenable: true,
    webPreferences: {
      contextIsolation: true,
    },
  });

  views.sidebar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "../preload/sidebar-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  views.sidebar.webContents.loadFile(path.join(__dirname, "../renderer/sidebar.html"));

  // Create all views at startup (no lazy loading)
  // All Google apps load in background, ready for instant switching
  // Views use session partition based on active profile for isolation
  const activeProfile = profileManager.getActiveProfile();
  const partition = profileManager.getPartitionName(activeProfile.id);

  for (const key of Object.keys(VIEW_URLS)) {
    views[key] = key === 'settings' ? createSettingsView() : createContentView(key, partition);
  }

  mainWindow.contentView.addChildView(views.mail);
  mainWindow.contentView.addChildView(views.sidebar);

  currentView = "mail";
  views.sidebar.webContents.once("dom-ready", () => {
    views.sidebar.webContents.send("sidebar-set-active", "mail");
  });

  layoutViews();
  createMenu();

  mainWindow.on("resize", layoutViews);

  // WebContentsView webContents are not destroyed automatically with the
  // window - close them explicitly and reset state so menu clicks after the
  // window is closed (macOS) recreate a fresh window instead of crashing
  mainWindow.on("closed", () => {
    for (const key of Object.keys(views)) {
      try {
        if (!views[key].webContents.isDestroyed()) {
          views[key].webContents.close();
        }
      } catch {}
    }
    views = {};
    mainWindow = null;
    if (isMac && app.dock) app.dock.setBadge("");
  });

  // Initialize sidebar with current profile
  notifySidebarProfileUpdate();
}

ipcMain.on("sidebar-switch", (event, view) => {
  if (VIEW_URLS[view]) showView(view);
});

app.whenReady().then(async () => {
  // Initialize profile manager with dynamically imported electron-store
  const Store = (await import("electron-store")).default;
  profileManager = new ProfileManager(Store);

  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});
