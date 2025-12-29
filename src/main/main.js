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

// Security: whitelist of allowed Google domains
// Any navigation/window.open to external URLs opens in default browser
// Update this list when adding new Google services
const INTERNAL_DOMAINS = [
  "mail.google.com",
  "calendar.google.com",
  "drive.google.com",
  "gemini.google.com",
  "keep.google.com",
  "tasks.google.com",
  "contacts.google.com",
  "accounts.google.com",      // Required for Google login/auth
  "myaccount.google.com",     // Account management
  "docs.google.com",          // Google Docs, Sheets, Slides
  "sheets.google.com",
  "slides.google.com",
  "forms.google.com",
  "google.com",                // General Google services
  "login.microsoftonline.com", // Microsoft Entra
  "microsoft.com",             // Microsoft services
  "okta.com",                  // Okta authentication
  "msauth.net",                // Microsoft authentication
  "live.com",                  // Microsoft Live services
  "sentry.io",                 // Sentry error tracking
];

function isInternalUrl(url) {
  try {
    const { hostname } = new URL(url);
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
  // Recreate all views with new profile partition
  recreateViews();
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
  // Allow internal Google domains, open everything else in default browser
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) {
      return { action: "allow" };
    }

    shell.openExternal(url);
    return { action: "deny" };
  });

  // Security: Intercept navigation attempts (clicking links, redirects)
  // Prevents external navigation, forces external URLs to open in default browser
  view.webContents.on("will-navigate", (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Sync sessions: When user completes login, restart window to sync all views
  // Detects navigation from accounts.google.com back to app domain
  let wasOnAccountsPage = false;
  let hasTriggeredRestart = false; // Prevent multiple restarts
  
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
      
      // If we just left accounts page and are now on a Google app, login completed
      // Only trigger if coming from Google accounts (not external SSO providers)
      if (wasOnAccountsPage && !hasTriggeredRestart && hostname !== "accounts.google.com" && hostname.includes("google.com")) {
        console.log(`[Session Sync] Login detected on ${key}, restarting window...`);
        hasTriggeredRestart = true;
        wasOnAccountsPage = false;
        
        // Try to fetch Google profile picture from Gmail after page fully loads
        if (key === 'mail') {
          console.log('[Session Sync] Waiting to extract profile picture...');
          setTimeout(() => {
            // Check if view still exists and is not destroyed
            const mailView = views['mail'];
            if (!mailView || mailView.webContents.isDestroyed()) {
              console.log('[Session Sync] View no longer available, skipping profile picture extraction');
              return;
            }
            console.log('[Session Sync] Attempting to extract profile picture from Gmail');
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
              console.log('[Session Sync] Profile picture extraction result:', JSON.stringify(result));
              if (result.success && result.url) {
                const activeProfile = profileManager.getActiveProfile();
                console.log('[Session Sync] Active profile:', activeProfile.id, activeProfile.name);
                if (activeProfile && !activeProfile.isDefault) {
                  console.log('[Session Sync] Saving avatar URL to profile:', result.url);
                  profileManager.updateProfile(activeProfile.id, { avatarUrl: result.url });
                } else {
                  console.log('[Session Sync] Skipping avatar update (default profile)');
                }
              } else {
                console.log('[Session Sync] No profile picture found on Gmail page');
              }
            }).catch(e => console.error('[Session Sync] Error fetching profile picture:', e));
          }, 4000); // Even longer delay to ensure Gmail UI is fully loaded
        }
        
        // Restart window after short delay to sync session across all views
        setTimeout(() => {
          restartMainWindow();
        }, 1000);
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
function recreateViews() {
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

  // Re-show current view
  mainWindow.addBrowserView(views.sidebar);
  mainWindow.addBrowserView(views[currentViewName]);
  currentView = currentViewName;

  layoutViews();
  
  // Update sidebar with new profile
  notifySidebarProfileUpdate();
  
  // Refresh menu to update profile checkmarks
  createMenu();
}


// View switching: Remove all views, then re-add sidebar + target view
// Order matters: sidebar added last stays on top (z-order)
// Views remain in memory when removed - no state loss
function showView(name) {
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
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    title: "",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
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
          submenu: [
            {
              label: "Mail",
              accelerator: "Cmd+1",
              click: () => showView("mail"),
            },
            {
              label: "Calendar",
              accelerator: "Cmd+2",
              click: () => showView("calendar"),
            },
            {
              label: "Drive",
              accelerator: "Cmd+3",
              click: () => showView("drive"),
            },
            {
              label: "Gemini",
              accelerator: "Cmd+4",
              click: () => showView("gemini"),
            },
            {
              label: "Keep",
              accelerator: "Cmd+5",
              click: () => showView("keep"),
            },
            {
              label: "Tasks",
              accelerator: "Cmd+6",
              click: () => showView("tasks"),
            },
            {
              label: "Contacts",
              accelerator: "Cmd+7",
              click: () => showView("contacts"),
            },
          ],
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