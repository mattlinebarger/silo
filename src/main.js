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

let mainWindow = null;
let views = {};
let currentView = "mail";

const isMac = process.platform === "darwin";

const VIEW_URLS = {
  mail: "https://mail.google.com",
  calendar: "https://calendar.google.com",
  drive: "https://drive.google.com",
  gemini: "https://gemini.google.com",
  keep: "https://keep.google.com",
  tasks: "https://tasks.google.com",
  contacts: "https://contacts.google.com",
  settings: `file://${path.join(__dirname, "settings.html")}`,
};

function loadMenuIcon(name) {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, "../assets/menu", `${name}.png`)
  );
  icon.setTemplateImage(true);
  return icon;
}

const menuIcons = {
  settings: loadMenuIcon("settings"),
  reload: loadMenuIcon("reload"),
};

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

/* -----------------------------
   Dock badge + notifications
------------------------------ */

ipcMain.on("unread-count", (event, count) => {
  if (isMac && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : "");
  }
});

ipcMain.on("notify", (event, { title, options }) => {
  new Notification({
    title,
    body: options?.body || "",
    silent: false,
  }).show();
});

/* -----------------------------
   BrowserView helpers
------------------------------ */

function createContentView(key) {
  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) {
      return { action: "allow" };
    }

    shell.openExternal(url);
    return { action: "deny" };
  });

  view.webContents.on("will-navigate", (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  view.webContents.loadURL(VIEW_URLS[key]);
  return view;
}

/* -----------------------------
   Layout
------------------------------ */

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

function showView(name) {
  currentView = name;

  for (const key of Object.keys(VIEW_URLS)) {
    if (views[key]) {
      try {
        mainWindow.removeBrowserView(views[key]);
      } catch {}
    }
  }

  mainWindow.addBrowserView(views.sidebar);
  mainWindow.addBrowserView(views[name]);

  views.sidebar.webContents.send("sidebar-set-active", name);
  mainWindow.setTitle("");

  layoutViews();
}

/* -----------------------------
   Create windows
------------------------------ */

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

/* -----------------------------
   Menu
------------------------------ */

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

/* -----------------------------
   App lifecycle
------------------------------ */

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
      preload: path.join(__dirname, "sidebar-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  views.sidebar.webContents.loadFile(path.join(__dirname, "sidebar.html"));

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
