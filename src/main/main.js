const {
  app,
  BrowserWindow,
  BrowserView,
  Menu,
  ipcMain,
  Notification,
  shell,
  nativeImage,
  dialog,
} = require("electron");
const path = require("path");
const ProfileManager = require("./profile-manager");

// Global state: single window with multiple persistent BrowserViews
// Each Google app lives in its own BrowserView (not tab/separate window)
// Views persist in memory even when hidden - maintains state between switches
let mainWindow = null;
let views = {}; // Registry of all BrowserViews keyed by name (mail, calendar, etc.)
let currentView = "mail"; // Tracks which content view is currently visible
let profileManager = null; // Profile manager instance
let globalRestartScheduled = false; // Prevent multiple views from scheduling restart simultaneously

const isMac = process.platform === "darwin";

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

// Security: whitelist of allowed Google domains for logging in/SSO
// Any navigation/window.open to external URLs opens in default browser
// Update this list when adding new Google services
const INTERNAL_DOMAINS = [
  "login.microsoftonline.com", // Microsoft Entra
  "microsoft.com",             // Microsoft services
  "okta.com",                  // Okta authentication
  "oktacdn.com",               // Okta CDN resources
  "oktapreview.com",           // Okta preview environments
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

// Check if URL is a Google app domain that should prompt user
// Also handles Google redirect URLs (www.google.com/url?q=...)
function isGoogleAppUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    
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
  
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['New Window', 'Default Browser', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Open Link',
    message: 'Where would you like to open this link?',
    detail: resolvedUrl,
  });
  
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
    if (hostname.endsWith('google.com') && urlObj.pathname === '/url') {
      const actualUrl = searchParams.get('q');
      if (actualUrl) {
        // Recursively check the actual destination URL
        return isInternalUrl(actualUrl);
      }
    }
    
    // Allow google.com domains for auth flows and app navigation
    if (hostname.endsWith('google.com')) {
      return true;
    }
    
    return INTERNAL_DOMAINS.some((domain) => hostname.endsWith(domain));
  } catch {
    return false;
  }
}

// IPC: Update macOS dock badge with unread count from Gmail
// Triggered by preload script monitoring Gmail's DOM/API
ipcMain.on("unread-count", (event, count) => {
  if (isMac && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : "");
  }
});

// IPC: Show native notifications from Google apps
ipcMain.on("notify", (event, { title, options }) => {
  new Notification({
    title,
    body: options?.body || "",
    silent: false,
  }).show();
});

// Profile IPC handlers
ipcMain.handle("profiles:get-all", () => {
  return {
    profiles: profileManager.getProfiles(),
    activeProfileId: profileManager.getActiveProfile().id,
  };
});

ipcMain.handle("profiles:create", (event, data) => {
  return profileManager.createProfile(data);
});

ipcMain.handle("profiles:update", (event, { id, updates }) => {
  return profileManager.updateProfile(id, updates);
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
  if (views.sidebar && views.sidebar.webContents) {
    const activeProfile = profileManager.getActiveProfile();
    views.sidebar.webContents.send("sidebar-profile-update", activeProfile);
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

  const view = new BrowserView({
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
    }
  });

  // Right-click context menu
  view.webContents.on('context-menu', (event, params) => {
    const { Menu, MenuItem, clipboard } = require('electron');
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
      enabled: view.webContents.canGoBack(),
      click: () => view.webContents.goBack()
    }));
    menu.append(new MenuItem({
      label: 'Forward',
      enabled: view.webContents.canGoForward(),
      click: () => view.webContents.goForward()
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

  // Sync sessions: When user completes login, restart window to sync all views
  // Detects navigation from accounts.google.com back to app domain
  let wasOnAccountsPage = false;
  let hasTriggeredRestart = false; // Prevent multiple restarts
  let loginCheckTimer = null; // Timer for delayed login detection
  
  view.webContents.on("did-start-loading", () => {
    try {
      const url = view.webContents.getURL();
      if (url && url.includes("accounts.google.com")) {
        wasOnAccountsPage = true;
      } else if (url && wasOnAccountsPage && !isInternalUrl(url)) {
        // Reset if we navigate to an external domain (like Okta)
        // This prevents triggering restart after external auth flows
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
      
      const hostname = new URL(url).hostname;
      const pathname = new URL(url).pathname;
      
      // Check if we're on an actual Google app page (not just accounts or generic google.com)
      const isOnGoogleApp = (
        hostname === 'mail.google.com' ||
        hostname === 'calendar.google.com' ||
        hostname === 'drive.google.com' ||
        hostname === 'keep.google.com' ||
        hostname === 'tasks.google.com' ||
        hostname === 'contacts.google.com' ||
        hostname === 'gemini.google.com'
      );
      
      // Skip intermediate pages like /a/domain/acs (Assertion Consumer Service)
      // These are part of the SSO flow, not the final destination
      const isIntermediatePage = (
        pathname.includes('/acs') ||
        pathname.includes('/a/') ||
        hostname === 'www.google.com'
      );
      
      // If we just left accounts page and are now on an actual Google app, login completed
      // Only trigger if coming from Google accounts (not external SSO providers)
      // AND we're on a real app page (not intermediate redirect)
      // AND no restart has been scheduled globally
      if (wasOnAccountsPage && !hasTriggeredRestart && !globalRestartScheduled && isOnGoogleApp && !isIntermediatePage) {
        hasTriggeredRestart = true;
        globalRestartScheduled = true;
        wasOnAccountsPage = false;
        
        // Try to fetch Google profile picture from Gmail after page fully loads
        if (key === 'mail') {
          setTimeout(() => {
            // Check if view still exists and is not destroyed
            const mailView = views['mail'];
            if (!mailView || mailView.webContents.isDestroyed()) {
              return;
            }
            mailView.webContents.executeJavaScript(`
              (function() {
                console.log('[Profile Debug] Starting profile picture search...');
                
                function getBestImageUrl(img) {
                  if (!img) return null;
                  const srcset = img.getAttribute('srcset') || img.srcset;
                  if (srcset) {
                    const srcsetParts = srcset.split(',').map(s => s.trim());
                    const lastPart = srcsetParts[srcsetParts.length - 1];
                    return lastPart.split(' ')[0];
                  }
                  return img.src;
                }

                function isValidProfileUrl(url) {
                  if (!url) return false;
                  if (url.includes('/icons/') || 
                      url.includes('google_workspace') ||
                      url.includes('logo') ||
                      url.includes('branding') ||
                      url.includes('avatar_anonymous')) {
                    return false;
                  }
                  return url.includes('googleusercontent') || 
                         url.includes('ggpht.com') || 
                         url.match(/lh[3-6]\\.google\\.com/);
                }
                
                const selectors = [
                  'button[aria-label*="Google Account"] img',
                  'a[aria-label*="Google Account"] img',
                  'img[aria-label="Google Account"]',
                  'a[href*="accounts.google.com"] img',
                  'a[href^="https://accounts.google.com/SignOutOptions"] img',
                  '[data-testid="profile-image"]',
                  'a[aria-label*="profile"] img',
                  'header img',
                  'div[role="banner"] img'
                ];
                
                // 1. Try Selectors
                for (const selector of selectors) {
                  const elements = document.querySelectorAll(selector);
                  for (const img of elements) {
                    const url = getBestImageUrl(img);
                    if (url && isValidProfileUrl(url)) {
                       const rect = img.getBoundingClientRect();
                       if (rect.width > 20 && rect.height > 20 && Math.abs(rect.width - rect.height) < 10) {
                          let finalUrl = url.replace(/=s\\d+-/g, '=s192-').replace(/\\/s\\d+-/g, '/s192-');
                          return { success: true, selector, url: finalUrl, method: 'selector' };
                       }
                    }
                  }
                }
                
                // 2. Positional Fallback (Top Right)
                const allImages = document.querySelectorAll('img');
                for (const img of allImages) {
                   const rect = img.getBoundingClientRect();
                   if (rect.top < 100 && rect.right > window.innerWidth - 150 && 
                       rect.width > 28 && rect.height > 28 && 
                       Math.abs(rect.width - rect.height) < 10) {
                       
                       const url = getBestImageUrl(img);
                       if (url && isValidProfileUrl(url)) {
                           let finalUrl = url.replace(/=s\\d+-/g, '=s192-').replace(/\\/s\\d+-/g, '/s192-');
                           return { success: true, selector: 'positional', url: finalUrl, method: 'positional' };
                       }
                   }
                }

                return { success: false };
              })();
            `).then(result => {
              if (result.success && result.url) {
                const activeProfile = profileManager.getActiveProfile();
                if (activeProfile && !activeProfile.isDefault) {
                  profileManager.updateProfile(activeProfile.id, { avatarUrl: result.url });
                }
              }
            }).catch(e => console.error('Error fetching profile picture:', e));
          }, 6000); // Longer delay to ensure Gmail UI is fully loaded
        }
        
        // Restart window after longer delay to ensure auth flow is completely done
        // This gives time for all redirects to complete
        setTimeout(() => {
          restartMainWindow();
          // Reset global flag after restart completes
          setTimeout(() => {
            globalRestartScheduled = false;
          }, 2000);
        }, 3000); // Increased from 1000ms to 3000ms
      }
    } catch (e) {
      console.error("Error in session sync:", e);
    }
  });

  view.webContents.loadURL(VIEW_URLS[key]);
  return view;
}

// Layout: Position BrowserViews using explicit bounds (CSS doesn't work on BrowserViews)
// Sidebar: Fixed 60px width at x:0
// Content: Fills remaining width starting at x:60
// Called on window resize to maintain layout
function layoutViews() {
  if (!mainWindow) return;

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
  if (!mainWindow) return;

  const currentViewName = currentView;

  // Remove all views from window
  for (const key of Object.keys(VIEW_URLS)) {
    if (views[key]) {
      try {
        mainWindow.removeBrowserView(views[key]);
        // Destroy the view to clear session
        views[key].webContents.destroy();
      } catch (e) {
        console.error(`Error destroying view ${key}:`, e);
      }
    }
  }

  // Get new partition for active profile
  const activeProfile = profileManager.getActiveProfile();
  const partition = profileManager.getPartitionName(activeProfile.id);
  const enabledApps = activeProfile.enabledApps || ['mail', 'calendar', 'drive', 'gemini', 'keep', 'tasks', 'contacts'];

  // Recreate all views with new partition
  for (const key of Object.keys(VIEW_URLS)) {
    // Settings view uses its own preload script
    if (key === 'settings') {
      views[key] = new BrowserView({
        webPreferences: {
          preload: path.join(__dirname, "../preload/settings-preload.js"),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      views[key].webContents.loadURL(VIEW_URLS[key]);
    } else {
      views[key] = createContentView(key, partition);
    }
  }
  
  // Check if current view is enabled, if not switch to first enabled app
  // Use override if provided (e.g., when switching profiles)
  let targetView = targetViewOverride || currentViewName;
  if (targetView !== 'settings' && !enabledApps.includes(targetView)) {
    // Target view is disabled, switch to first enabled app
    targetView = enabledApps[0] || 'mail';
    console.log(`Target view ${targetView} is disabled, switching to ${targetView}`);
  }

  // Re-show target view
  mainWindow.addBrowserView(views.sidebar);
  mainWindow.addBrowserView(views[targetView]);
  currentView = targetView;

  layoutViews();
  
  // Update sidebar with new profile and active view
  notifySidebarProfileUpdate();
  views.sidebar.webContents.send("sidebar-set-active", targetView);
  
  // Refresh menu to update profile checkmarks
  createMenu();
}


// View switching: Remove all views, then re-add sidebar + target view
// Order matters: sidebar added last stays on top (z-order)
// Views remain in memory when removed - no state loss
function showView(name) {
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

  // Remove all views from window (but don't destroy them)
  for (const key of Object.keys(VIEW_URLS)) {
    if (views[key]) {
      try {
        mainWindow.removeBrowserView(views[key]);
      } catch {}
    }
  }

  // Re-add sidebar and target content view
  // Sidebar must be added last to maintain proper z-order
  mainWindow.addBrowserView(views.sidebar);
  mainWindow.addBrowserView(views[name]);

  views.sidebar.webContents.send("sidebar-set-active", name);
  mainWindow.setTitle("");

  layoutViews();
}

// Open compose/create actions in separate window (not BrowserView)
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

function restartMainWindow() {
  if (!mainWindow) return;
  
  console.log("[Session Sync] Restarting window to sync sessions...");
  
  // Save current view before destroying
  const savedView = currentView;
  
  // Destroy all views
  for (const key of Object.keys(VIEW_URLS)) {
    if (views[key]) {
      try {
        mainWindow.removeBrowserView(views[key]);
        views[key].webContents.destroy();
      } catch (e) {
        console.error(`Error destroying view ${key}:`, e);
      }
    }
  }
  
  // Destroy sidebar
  try {
    mainWindow.removeBrowserView(views.sidebar);
    views.sidebar.webContents.destroy();
  } catch (e) {
    console.error("Error destroying sidebar:", e);
  }
  
  // Close and destroy the window
  mainWindow.destroy();
  mainWindow = null;
  views = {};
  
  // Recreate window after short delay
  setTimeout(() => {
    createMainWindow();
    // Restore the view user was on
    if (savedView && VIEW_URLS[savedView]) {
      showView(savedView);
    }
    // Notify sidebar of profile
    notifySidebarProfileUpdate();
    console.log("[Session Sync] Window restarted");
  }, 100);
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

  views.sidebar = new BrowserView({
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
    // Settings view needs its own preload script for profile management
    if (key === 'settings') {
      views[key] = new BrowserView({
        webPreferences: {
          preload: path.join(__dirname, "../preload/settings-preload.js"),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      views[key].webContents.loadURL(VIEW_URLS[key]);
    } else {
      views[key] = createContentView(key, partition);
    }
  }

  mainWindow.addBrowserView(views.sidebar);
  mainWindow.addBrowserView(views.mail);

  currentView = "mail";
  views.sidebar.webContents.once("dom-ready", () => {
    views.sidebar.webContents.send("sidebar-set-active", "mail");
  });

  layoutViews();
  createMenu();

  mainWindow.on("resize", layoutViews);
  
  // Clean up listener when window is closed to prevent memory leak warnings
  mainWindow.on("closed", () => {
    mainWindow.removeListener("resize", layoutViews);
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