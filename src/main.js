const { app, BrowserWindow, shell } = require('electron')
const log = require('electron-log')
const windowStateKeeper = require('electron-window-state')
const { IpfsConnector } = require('@akashaproject/ipfs-connector')
const fs = require('fs')
const path = require('path')
const { promisify } = require('util')

const { getLatestFromRepo } = require('./lib/aragon-core')
const {
  listenAndPinResources,
  pinAragonClientForNetwork,
  purgeUnusedIpfsResources
} = require('./lib/ipfs-caching')
const storage = require('./lib/storage')

const PINNED_INITIAL_CLIENT_KEY = 'main:initialClient'

const ipfsInstance = IpfsConnector.getInstance()
let startedIpfs = false

// Put the IPFS binary into the userData
// This avoids collisions if a user already has an IPFS binary installed
const ipfsPath = path.join(app.getPath('userData'), 'go-ipfs')
ipfsInstance.setBinPath(ipfsPath)

// Init IPFS in the userData as well
const ipfsInitPath = path.join(app.getPath('userData'), 'ipfs-init')
ipfsInstance.setIpfsFolder(ipfsInitPath)

async function loadAragonClient (network = 'main') {
  const latestHashForNetwork = await getLatestFromRepo('aragon.aragonpm.eth', network)
  await pinAragonClientForNetwork(latestHashForNetwork, network)

  return latestHashForNetwork
}

async function start (mainWindow) {
  try {
    const version = await ipfsInstance.api.apiClient.version()
    log.info(`Detected running instance of IPFS ${version ? `(version: ${version.version})` : ''}, no need to start our own`)
  } catch (e) {
    log.info('Could not detect running instance of IPFS, starting it ourselves...')
    await ipfsInstance.start()
    startedIpfs = true
  }

  const pinnedInitial = await storage.get(PINNED_INITIAL_CLIENT_KEY)
  if (!pinnedInitial || !pinnedInitial.isPinned) {
    // Initial run; pin the bundled Aragon client to the bundled IPFS node
    const bundledClientPath = './assets/aragon-client/main'
    const bundledClientHashes = await promisify(fs.readdir)(bundledClientPath)

    if (bundledClientHashes.length > 1) {
      log.warn('App has bundled more than one Aragon client!')
    }

    log.info(`Pinning bundled Aragon client (${bundledClientHashes[0]})`)

    await promisify(ipfsInstance.api.apiClient.util.addFromFs)(
      path.join(bundledClientPath, bundledClientHashes[0]),
      { recursive: true }
    )
    await pinAragonClientForNetwork(bundledClientHashes[0], 'main')
    await storage.set(PINNED_INITIAL_CLIENT_KEY, { isPinned: true })
  }

  log.info('Loading Aragon client...')
  const latestClientHash = await loadAragonClient()
  mainWindow.loadURL(`http://localhost:8080/ipfs/${latestClientHash}`)

  listenAndPinResources()
  await purgeUnusedIpfsResources()
}

function createWindow () {
  const mainWindowState = windowStateKeeper({
    defaultWidth: 1200,
    defaultHeight: 800
  })

  const mainWindow = new BrowserWindow({
    title: 'Aragon',
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    backgroundColor: '#f7fbfd',
    icon: path.join(__dirname, 'app/assets/icon.png'),
    webPreferences: {
      nodeIntegration: false
    }
  })

  mainWindow.setMenu(null)

  mainWindowState.manage(mainWindow)

  mainWindow.loadURL(`file://${path.join(__dirname, '../assets/loading.html')}`)

  start(mainWindow)

  if (process.env.NODE_ENV === 'development') {
    setTimeout(() => mainWindow.webContents.openDevTools({mode: 'detach'}), 1000)
  }

  // Sniff new windows from anchors and open in external browsers instead
  mainWindow.webContents.on('new-window', function(event, url){
    event.preventDefault();
    log.info(`Opening ${url} in an external browser`)
    shell.openExternal(url)
  });

  // Sniff navigation requests
  const navigationRegex = /https?:\/\/(rinkeby|mainnet).aragon.org\/?/
  mainWindow.webContents.on('will-navigate', async (event, url) => {
    // Handle the navigation ourselves
    event.preventDefault()

    const matchesAragonApp = url.match(navigationRegex)
    if (Array.isArray(matchesAragonApp)) {
      // If we're going to a different network for the client, load it from IPFS instead
      const network = matchesAragonApp[1] // Network is the first capture group
      log.info(`Navigating app to ${network} via IPFS instead`)

      // In case it takes a while to pin and load, reset to the loading screen
      mainWindow.loadURL(`file://${path.join(__dirname, '../assets/loading.html')}`)

      const latestClientHash = await loadAragonClient(network === 'mainnet' ? 'main' : network)
      mainWindow.loadURL(`http://localhost:8080/ipfs/${latestClientHash}`)
    } else {
      // Otherwise, open it in the OS' default browser
      log.info(`Opening ${url} in an external browser`)
      shell.openExternal(url)
    }
  })
}

async function shutdown() {
  if (startedIpfs) {
    log.info(`Quitting IPFS...`)
    await ipfsInstance.stop()
  }
  log.info(`Quitting...`)
  app.quit()
}

app.on('ready', createWindow)

if (process.platform === 'darwin') {
  app.on('will-quit', shutdown)
} else {
  app.on('window-all-closed', shutdown)
}
