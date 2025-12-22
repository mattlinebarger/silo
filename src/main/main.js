const {
  app,
  BrowserWindow,
  BrowserView,
  Menu,
  ipcMain,
  Notification,
  shell,
  nativeImage,
} = require("electron");
const path = require("path");

// Global state: single window with multiple persistent BrowserViews
// Each Google app lives in its own BrowserView (not tab/separate window)
// Views persist in memory even when hidden - maintains state between switches
let mainWindow = null;
let views = {}; // Registry of all BrowserViews keyed by name (mail, calendar, etc.)
let currentView = "mail"; // Tracks which content view is currently visible

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

function createContentView(key) {
  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
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
  for (const key of Object.keys(VIEW_URLS)) {
    views[key] = createContentView(key);
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
}

ipcMain.on("sidebar-switch", (event, view) => {
  if (VIEW_URLS[view]) showView(view);
});

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});