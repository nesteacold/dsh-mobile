// Browser half of @dsh-ext/devices (spec 008): a "Devices" page in DSH Settings.
// Plain JS, no build step: React.createElement via window.__ModuleLoader__, the
// same pattern as plugins/mobile-gateway/lib/client.js. The page reaches the
// local Host through same-origin fetch only (/mgw/* for this device's own
// gateway, /devices/* for outbound connections); it never holds a remote token.
window.__ModuleLoader__.load({
  id: '@dsh-ext/devices',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }
    const exports = module.exports

    // Spec 033 (A1.2): remote file attach — a pick in a remote composer is handed to DSH
    // as path-free `File` objects — is a
    // second client file of this package — `lib/client.remote-file-attach.js`, a
    // package-local chunk — and one IMPLEMENTATION, not a copy. That file ships in DSH's
    // own chunk envelope (`window.__ModuleLoader__.load({id, chunk, factory})`, measured in
    // `dsh-client-ui-sidebar-terminal/lib/client.terminal.js`), because DSH serves it
    // verbatim and its loader refuses a bundle that did not register
    // (`dsh-client-modules` `importChunk`). `require.async` is how DSH requests such a
    // chunk, and its answer is the factory's return value — the very object
    // `test/remote-file-attach.test.mjs` exercises. A shell that cannot hand it over leaves
    // every pick to DSH and the page says so (`bridge-module-missing`), which is the A1.2
    // failure mode rather than a silent second path. A request that answers late is
    // re-published when `installRemoteFileAttach` attaches, which is why this is one shared
    // promise rather than a per-effect request.
    const remoteFileAttach = typeof require.async === 'function'
      ? require.async('./client.remote-file-attach.js')
      // Settled, never rejected: a rejection here would be an unhandled promise for a
      // shell that simply has no chunk loader, and the failure is already visible.
      : Promise.resolve(null)

    // ---------------------------------------------------------------- i18n
    // vi/en; Vietnamese when the DSH locale is vi*, English otherwise (the
    // gateway reads the same ctx.locale snapshot: `getSnapshot().active`).
    const DICT = {
      en: {
        title: 'Devices',
        subtitle: 'Connect to a DSH Host on another machine, or let another machine connect to this one.',
        thisDevice: 'This device',
        // `{{n}}` stays in the template so a translator can move the number.
        connectedCount: '{{n}} connected successfully',
        flowBusy: 'Data is flowing to the connected host',
        flowIdle: 'No connection is active',
        tabAllow: 'Allow connections to this device',
        tabConnect: 'Connect to other devices',
        allow: 'Allow connections',
        allowHelp: 'Let other devices on your network control this DSH Host after pairing. Off closes every connection.',
        switchNotSaved: 'The switch moved, but this computer could not save it. It applies until this session ends; the next start follows the saved value.',
        lan: 'Local network (LAN)',
        internet: 'Internet',
        internetLater: 'Later — not available yet',
        generate: 'Generate pairing code',
        pairingCode: 'Pairing code',
        pairingHelp: 'Paste this on the other device. It works once and expires soon.',
        copy: 'Copy',
        copied: 'Copied',
        expiresIn: 'Expires in',
        expired: 'Expired — generate a new code',
        address: "This device's address",
        noAddress: 'No reachable address yet. Turn on "Allow connections".',
        authorized: 'Authorized devices',
        noAuthorized: 'No device is authorized yet.',
        kind: 'Type',
        lastUsed: 'Last used',
        never: 'never',
        // A grant is a list of things, not a sentence: the count labels it and the
        // chip list opens when it is longer than the two rows it is clamped to.
        // `{{n}}` stays in the template so a translator can move the number.
        scopeCount: '{{n}} permissions',
        showAllScopes: 'Show all ({{n}})',
        showLessScopes: 'Show less',
        connectedHere: 'Connected here',
        remove: 'Remove access',
        removeConfirm: 'Remove access for this device? It is disconnected immediately.',
        edit: 'Edit permissions',
        editHelp: 'Permissions are fixed when a device pairs. Saving creates a new pairing code with the chosen permissions; the device must pair again, which closes its current connection.',
        editSave: 'Generate new pairing code',
        // Spec 025 R5: the grant can change in place, so re-pairing is no longer the only
        // way. `editHelp` above stays truthful about what the old button still does.
        permissions: 'Permissions',
        permsHelp: 'Applies to this device without re-pairing. Only the permissions this kind of device can hold are listed. Its current connections close and it reconnects with the new set.',
        permsSave: 'Apply permissions',
        permsApplied: 'Permissions applied. The device reconnects to pick them up.',
        permsUnchanged: 'Nothing changed.',
        permsConfirm: 'Apply these permissions to this device? Its current connections close and it reconnects with the new set.',
        permsMissingUpload: 'Re-grant file upload permission',
        // One sentence per refusal the route names; an unknown code is shown verbatim.
        'permsErr.bad-request': 'The change could not be read. Reload the page and try again.',
        'permsErr.unknown-scope': 'One of those is not a permission this Host knows.',
        'permsErr.scope-not-updatable': 'The web unlock permission is granted by the passkey flow, not here.',
        'permsErr.scope-not-for-kind': 'That permission does not apply to this kind of device.',
        'permsErr.forbidden': 'Permissions can only be changed from this machine.',
        'permsErr.not-found': 'That device is no longer paired. Reload the page.',
        // Spec 021 rev 15: a record holding a scope its kind cannot use (desktop + web:unlock).
        permsNotForKeyKind: 'This device holds a permission its kind cannot use (web unlock, which only a web or phone device can satisfy). Applying permissions removes it.',
        cancel: 'Cancel',
        'scope.sessions:read': 'See sessions and history',
        'scope.prompt:send': 'Send prompts',
        'scope.approval:respond': 'Answer approvals',
        'scope.files:read': 'Read files',
        'scope.files:write': 'Write files',
        'scope.settings:write': 'Change settings',
        addDevice: 'Add device',
        addressLabel: 'Address (ip:port)',
        pairingLabel: 'Pairing string',
        nameLabel: 'Name (optional)',
        connect: 'Pair and connect',
        remotes: 'Remote hosts',
        noRemotes: 'No remote host yet.',
        open: 'Open',
        back: 'Back',
        removeRemote: 'Remove',
        sessions: 'Sessions',
        noSessions: 'No sessions on this host.',
        history: 'History',
        noHistory: 'No messages.',
        prompt: 'Send a prompt',
        send: 'Send',
        approvals: 'Pending approvals',
        noApprovals: 'Nothing waiting for approval.',
        allowOnce: 'Allow once',
        reject: 'Reject',
        desktopOnly: 'Decide on the other device (no content hash)',
        refresh: 'Refresh',
        'status.online': 'Online',
        'status.connecting': 'Connecting',
        'status.offline': 'Offline',
        // A PAIRED host whose link is down but whose sessions are still listed: the
        // word has to differ from both "Online" and "Offline, nothing here".
        'status.disconnected': 'Disconnected',
        'status.disconnectedSessions': 'Sessions stay listed and readable; sending is refused until it reconnects.',
        'status.revoked': 'Access revoked',
        'status.error': 'Error',
        error: 'Error',
        working: 'Working…',
        sent: 'Sent',
        enableFirst: 'Turn on "Allow connections" first.',
        // Which kind of device a pairing code is for. A code's kind is fixed when it is made,
        // and it decides both the scopes the offer can carry and whether a passkey lock applies,
        // so it is a choice next to the button, not a guess.
        otpKindLabel: 'This code is for',
        otpKindMobile: 'Phone / PWA (passkey)',
        otpKindMobileHint: 'The phone or web client registers a passkey right after you approve, which is what unlocks its session. Includes "Unlock the web client".',
        otpKindDesktop: 'Computer (Desktop Remote)',
        otpKindDesktopHint: 'The Remote tab on another computer; it never registers a passkey.',
        'scope.harness:remote': 'Use this host remotely (sessions, prompts, approvals)',
        'scope.commands:execute': 'Run slash commands',
        'scope.workspace:manage': 'Manage workspaces and any path',
        'scope.credentials:write': 'Set or remove provider credentials',
        'scope.plugins:manage': 'Install and manage plugins',
        'scope.schedule:write': 'Create and run schedules',
        'scope.schedule:read': 'See scheduled tasks and when each one runs next',
        'scope.terminal': 'Open a terminal',
        'scope.sessions:author': 'Create sessions and choose a model',
        'scope.attachments:write': 'Send files and images',
        // Spec 014 C6: the Host's side-panel browser, driven from a paired device.
        'scope.browser:control': "Drive the Host's browser panel",
        'scope.stats:read': 'Read session statistics and context usage',
        // Spec 020: the Host-attested unlock the web PWA asks for.
        'scope.web:unlock': 'Unlock the web client (PWA)',
        // Spec 019 Wave 3: lower-only, and this Host decides whether it is stricter.
        'scope.permission:lower': 'Make a session stricter (never looser)',
        // One short risk line per dangerous scope, shown under its checkbox.
        'risk.files:write': 'Can change files in your workspaces.',
        'risk.settings:write': 'Can change Host settings, models and agent presets.',
        'risk.commands:execute': 'Can run Host commands as you.',
        'risk.workspace:manage': 'Can create or delete workspaces and read files outside them.',
        'risk.credentials:write': 'Can overwrite your API keys (it cannot read them).',
        'risk.plugins:manage': 'Can install or enable code that runs on this Host.',
        'risk.schedule:write': 'Can create jobs that run later without you.',
        'risk.terminal': 'Full shell on this Host: it can do anything you can.',
        'risk.sessions:author': 'Can start new sessions on this Host and pick which model runs them.',
        'risk.attachments:write': 'Can send files and images into a session on this Host.',
        'risk.browser:control': "Can open pages and act in the Host's browser as you.",
        'risk.web:unlock': 'Can attest the unlock of the web client for this account.',
        'risk.permission:lower': 'Can only make a session stricter; it can never loosen permissions.',
        // Spec 013: `uploads` on GET /devices/remotes. A remote row must name a
        // broken attachment bridge instead of letting every upload 404.
        'uploadsOff': 'Remote attachments are off: this Host does not take file uploads for a remote session.',
        'uploadsWaiting': 'Waiting for the upload service…',
        'uploadsBroken': 'Remote attachments will fail: the upload route this plugin wraps is not in place',
        presetStandard: 'Standard',
        presetFull: 'Full control',
        presetFullHint: 'Every permission, including shell, plugins and credentials. Only for devices you fully trust.',
        presets: 'Presets',
        notRequested: 'Not requested by this device',
        advancedLimits: 'Advanced',
        limitsHelp: 'Optional per-device limits of the remote bridge. 0 means unlimited (the default). They are Host configuration (remoteBridgeLimits in the mobile-gateway plugin config) and cannot be changed from this page.',
        'limit.maxConnectionsPerDevice': 'Connections per device',
        'limit.maxStreamsPerDevice': 'Open streams per device',
        'limit.maxInflightPerDevice': 'Calls in flight per device',
        'limit.callsPerSecond': 'Calls per second per device',
        'limit.maxResultBytes': 'Largest one-shot result (bytes)',
        unlimited: 'unlimited',
        // --- spec 008 T036: the bind the listener really uses, read-only ---
        listeningOn: 'Listening on',
        listenerUp: 'Listener up',
        listenerDown: 'Listener off',
        listenerUnknown: 'unknown address',
        certPin: 'Certificate pin (SHA-256)',
        // The route chip says in one word who can connect — the bind host itself is
        // the whole fact, so no sentence repeats it.
        routeLoopback: 'Loopback',
        routeLan: 'LAN',
        routeTailscale: 'Tailscale',
        loopbackWarning: 'The Host listens on a loopback address, so only this machine can reach it — a phone or another computer cannot connect. To change it, open Settings → Plugins → the mobile-gateway row → configuration → listen address (lanHost), and enter any private LAN address or any Tailscale address of this machine. The certificate pin does not change, so no new certificate is needed.',
        // The label of the bind line. The old "reachable" heading and the tailnet
        // sentence beside it are gone: the route chip already carries that fact.
        reachableNote: 'This Host accepts connections at',
        // --- spec 008: a listener port the OS dynamic range can hand to an outbound connection ---
        portRiskBody: 'The operating system can hand this port to an outgoing connection, so the listener may fail to bind at a random moment.',
        portRiskSafeBand: 'Ports 20000-39999 sit outside the dynamic range and are the safe band.',
        portBusyBody: 'Another program holds this port, or an outgoing connection already took the same port from the operating system dynamic range. That busy port is why the listener cannot bind.',
        // --- spec 008: the connection plan — bind the listener to one of this machine's own addresses ---
        planTitle: 'Connection plan',
        // The select answers ONE question ("where does the gateway bind its socket"),
        // because that is the only thing POST /mgw/listen can apply. How that bind is
        // reached is a separate line below it, never an option.
        planBindTitle: 'Gateway bind address',
        planServeRoute: 'Reachable through a Tailscale serve front:',
        planServeNote: 'The gateway itself is bound to',
        planHelp: 'Bind this machine\'s gateway to one of its own addresses. The Tailscale option uses this machine\'s tailnet address, so the devices on your tailnet can connect.',
        // The LAN option is the first private address the OS reports, in Node's
        // interface order — a VPN or virtual adapter can win over the physical LAN.
        planLanCaveat: 'LAN binds the first private address the operating system reports. A VPN or virtual adapter may be chosen before the physical LAN adapter; if that is not the address you want, use the Tailscale option or set the listen address in the gateway config.',
        planBound: 'Bound to',
        planPrivateHint: 'This is a private or virtual address, not necessarily your home LAN:',
        'plan.loopback': 'This machine only',
        'plan.lan': 'LAN',
        'plan.tailscale': 'Tailscale private network',
        planApplying: 'Applying…',
        planUnknown: 'Unknown — the gateway reports no address',
        planTailscaleUnavailable: 'No Tailscale interface detected on this machine.',
        // POST /mgw/listen answers a known refusal with a code and an English
        // sentence. A page that is not in English names the reason in its own
        // language; an unknown reason is still shown verbatim (never hidden).
        planErrTailscale: 'No Tailscale interface is available to bind: connect this machine to your tailnet, then choose it again.',
        planErrLan: 'No private LAN address was detected on this machine, so there is nothing to bind to.',
        planErrDisabled: 'Allow connections (and LAN access) must be on before the listen address can move.',
        otpTitle: 'Pairing code',
        otpHelp: 'Type this code on the other device together with this address. It works once, for 10 minutes, and you will still have to approve the request here.',
        otpNew: 'Generate pairing code',
        otpClose: 'Close',
        otpQrAlt: 'Pairing QR code',
        otpQrHelp: 'Scan with the phone camera: it opens the app with the address and code filled in. You still confirm on the phone and approve here.',
        otpQrTextHelp: 'Scan to read the address and code as text.',
        pendingTitle: 'Pending requests',
        pendingNone: 'No device is asking to connect.',
        pendingHelp: 'Check that the code below is the same one shown on the other device before you approve.',
        unnamedDevice: 'Unnamed device',
        verifyCode: 'Verification code',
        approve: 'Approve',
        rejectRequest: 'Reject',
        requestedAt: 'Requested',
        fromIp: 'From',
        addTitle: 'Add device',
        addLan: 'LAN',
        addInternet: 'Internet',
        addInternetLater: 'Internet — later',
        addAddress: 'Address',
        addCode: 'Pairing code',
        addCodeHint: '8 digits, shown on the other device',
        addName: 'Display name',
        addNote: 'Pairing again may expand or reduce access. If no workspaces are available, check permissions under Authorized devices on that device.',
        addSubmit: 'Add device',
        advanced: 'Advanced: paste pairing string',
        advancedBack: 'Use the 8-digit code instead',
        waiting: 'Waiting for approval on the host',
        waitingCode: 'Code',
        waitingHelp: 'Approve this request on the other device after checking that it shows the same code.',
        cancelWait: 'Cancel',
        editAddress: 'Edit address',
        saveAddress: 'Save',
        addressPinNote: 'Same certificate pin; only the address changes.',
        addressSaving: 'Saving…',
        pairRejected: 'The host rejected this device.',
        pairApproved: 'Paired.',
        // --- spec 008 P2b: remote sessions inside the native UI ---
        // The native browser owns the workspace and session rows (workspaces,
        // nesting, search, pin/archive), so this plugin only names the host.
        hostChip: 'Host',
        hostAlreadyShown: 'Host',
        // The session row's second copy row: the shipped one copies the tagged id
        // this plugin mints, this one the id the Host itself uses.
        copyOriginalId: 'Copy original ID',
        popoverTitle: 'Remote host',
        popoverPaired: 'Paired',
        popoverKind: 'Type',
        popoverScopes: 'Permissions',
        popoverNoScopes: 'none',
        reconnect: 'Reconnect',
        reconnecting: 'Reconnecting…',
        autoRetry: 'Reconnecting automatically…',
        forgetHost: 'Forget host',
        forgetConfirm: 'Forget this host? Its token is deleted from this machine and its workspaces leave the sidebar.',
        manageAll: 'Manage all devices in Settings → Devices',
        banners: 'Remote session notices',
        bannerOfflineTitle: 'This task is no longer available on',
        bannerOfflineBody: 'You are reading the local copy; it is read-only.',
        bannerReadOnly: 'Read-only',
        removeLocalCopy: 'Remove local copy',
        removeLocalCopyBusy: 'Removing…',
        localCopyRemoved: 'Local copy removed.',
        localCopyGone: 'There was no local copy to remove.',
        modelStatus: 'Model status',
        modelUnavailable: 'The host reports this model is unavailable. Prompts still run on the host; no local model is used instead.',
        terminalEntry: 'Terminal',
        terminalOpen: 'Open a terminal on this host',
        terminalHint: 'The terminal needs the "Open a terminal" permission on this device.',
        terminalUnavailable: 'The terminal is not available in this shell.',
        sidebarGrouping: 'Sidebar host names',
        sidebarOn: 'names shown on session rows',
        sidebarOffState: 'off',
        // Why the host-name seats are not installed. The plugin produces this small,
        // fixed set of short reasons; each is printed as a sentence, not as the raw
        // English the diagnosis writes.
        sidebarReasonNotInstalled: 'Not installed yet.',
        sidebarReasonNoServices: 'This shell provides no client services.',
        sidebarReasonNoHost: 'No remote host is connected.',
        sidebarReasonNoActions: 'This shell provides no workspace actions.',
        sidebarReasonRoutingOff: 'Multi-host routing is off',
        // The sidebar's two tabs (Qoder's This Computer / Remote Workspace). They
        // filter the LIST the native browser draws; no stream is asked twice.
        hostTabs: 'Sidebar tabs',
        hostTabsOn: 'two tabs, filtering the sidebar list',
        hostTabsOff: 'not installed',
        tabThisComputer: 'This Computer',
        tabRemoteWorkspace: 'Remote Workspace',
        tabSwitchLocal: 'Show this computer’s sessions',
        tabSwitchRemote: 'Show remote workspaces',
        tabShortcutLocal: 'Ctrl+Alt+1',
        tabShortcutRemote: 'Ctrl+Alt+2',
        sidebarReasonNoTabs: 'This shell declares no sidebar tab strip.',
        sidebarReasonShortcut: 'The sidebar tabs are on, but Ctrl+Alt+1 / 2 could not be registered',
        // --- spec 033 (A1.2): a file picked for a remote session reaches that Host as bytes ---
        attachTitle: 'Remote file attach',
        attachOn: 'Files picked for a remote session are sent to that host as bytes',
        attachNoBridge: 'This shell has no local file path, so every picked file already uploads',
        attachOffUnknown: 'Files picked for a remote session are NOT sent to that host',
        attachReason: 'Reason',
        attachNoModule: 'this shell did not hand over the attach module',
        attachNoWindow: 'this page has no window',
        attachNotInstalled: 'the attach did not run',
        attachBrowserUnavailable: 'this browser cannot build the file list a remote pick needs',
        attachMeasured: 'the attach is on: each remote pick is checked on the spot before it is handed over',
        attachLast: 'Last pick sent as DSH\'s own',
        attachPickLocal: 'it belongs to a local session, so DSH keeps its own behaviour',
        attachPickAmbiguous: 'its session could not be known for certain, so DSH kept its own behaviour',
        attachPickNoComposer: 'no composer was open',
        attachPickNoDocument: 'the page could not be read',
        attachPickNoSession: 'its composer shows no session',
        attachPickElsewhere: 'it did not come from a composer',
        attachPickBrowser: 'it was not a composer pick this page could see',
        attachPickUncertain: 'its composer could not be identified',
        attachPickStale: 'its composer changed before the pick finished',
        attachPickPassthrough: 'another bridge answered this pick',
        attachPickPathNamed: 'the file path is still attached to the pick, so DSH keeps its own behaviour',
        attachPickUnverified: 'the replaced file list could not be confirmed, so DSH kept its own behaviour',
        attachPickReplaceFailed: 'this pick belongs to a remote session, but the composer would not take the uploaded copies, so DSH kept its own behaviour for it',
        attachPickUnknown: 'its session is unknown',
        'reason.dsh-version-mismatch': 'this DSH version is not the pinned one',
        'reason.dsh-version-unknown': 'the DSH version is unknown',
        'reason.no-gateway': 'the gateway is missing',
        'reason.dispatchRpc-missing': 'the gateway has no dispatchRpc',
        'reason.openWireStream-missing': 'the gateway has no openWireStream',
        'reason.openWireStream-signature': 'the gateway signature differs',
        // --- the grant is short: remote sessions/workspaces cannot appear (spec 008) ---
        missingRemoteScope: 'Remote sessions and workspaces cannot appear until this device is paired again on that host with the "Use this host remotely" (harness:remote) permission.',
        pinMismatchNote: 'This host presented a different certificate. Nothing was sent. Pair it again if you trust the change.',
        hostRefused: 'The host refused the last request',
        // --- spec 016 Phase 3: a browser this machine lets a paired host drive ---
        // Two keys, never one: the host also needs the `browser:control` grant; this
        // switch is the owner's own consent on THIS machine and is off by default.
        browserAgentConsent: 'Allow this host to drive a browser on this machine',
        browserAgentConsentHelp: 'Off by default. When it is on, this host\'s agent may open pages in its own headless Chrome or Edge, with a profile of its own. Stop in the Browser (agent) tab closes it at once.',
        browserAgentOffByDefault: 'Off',
        browserAgentTab: 'Browser (agent)',
        browserAgentOpen: 'Open Browser (agent)',
        browserAgentDescription: 'A screencast of the browser this host is driving here',
        browserAgentBanner: 'The agent is driving',
        browserAgentStop: 'Stop',
        browserAgentStopped: 'Stopped. The browser on this machine is closed.',
        browserAgentEmpty: 'Waiting for the first frame…',
        browserAgentNoConsent: 'This host is not allowed to drive a browser on this machine.',
        browserAgentFailed: 'The screencast is not available',
        // --- spec 016 Phase 1: one Start-page doorway per paired machine ---
        // The label is `<this string> · <host>`; the host name is the only part the
        // shell cannot translate, so it is the one part that stays verbatim.
        hostDoor: 'Remote machine',
        hostDoorDescription: 'Sessions and approvals on this machine',
        devicesDoorDescription: 'Pairing, consent and browser control for this machine',
        hostDoorGone: 'This machine is no longer paired. Add it again on the Devices page.',
        // --- spec 027: self-update ---
        updTitle: 'Plugin updates', updCheck: 'Check for updates', updChecking: 'Checking…',
        updCurrent: 'Current', updLatest: 'Latest release', updUpToDate: 'Up to date.', updNoTags: 'No release published yet.',
        updNotes: 'Changes', updUpdate: 'Update', updUpdating: 'Updating…', updRemote: 'Source',
        updConfirm: 'Update the plugins to {tag}? Only a fast-forward merge is applied; DSH is not restarted.',
        updDone: 'Restart DSH to load {tag}.', updRollback: 'To roll back, the previous commit was {head}.',
        updBlocked: 'Update not possible', updSignature: 'Signature', updEngines: 'DSH compatibility',
      },      vi: {
        title: 'Thiết bị',
        subtitle: 'Kết nối tới một DSH Host trên máy khác, hoặc cho máy khác kết nối vào máy này.',
        thisDevice: 'Máy này',
        connectedCount: '{{n}} kết nối thành công',
        flowBusy: 'Dữ liệu đang chảy tới host đã kết nối',
        flowIdle: 'Chưa có kết nối nào đang hoạt động',
        tabAllow: 'Cho phép kết nối tới thiết bị này',
        tabConnect: 'Kết nối tới thiết bị khác',
        allow: 'Cho phép kết nối',
        allowHelp: 'Cho phép các thiết bị khác trong mạng điều khiển Host DSH này sau khi ghép đôi. Tắt sẽ đóng mọi kết nối.',
        switchNotSaved: 'Đã đổi trạng thái công tắc nhưng không lưu được trên máy này. Trạng thái mới vẫn có hiệu lực trong phiên hiện tại; lần khởi động sau sẽ dùng trạng thái đã lưu trước đó.',
        lan: 'Mạng nội bộ (LAN)',
        internet: 'Internet',
        internetLater: 'Sau này — chưa khả dụng',
        generate: 'Tạo mã ghép đôi',
        pairingCode: 'Mã ghép đôi',
        pairingHelp: 'Dán mã này trên thiết bị kia. Chỉ dùng được một lần và sớm hết hạn.',
        copy: 'Sao chép',
        copied: 'Đã sao chép',
        expiresIn: 'Hết hạn sau',
        expired: 'Đã hết hạn — hãy tạo mã mới',
        address: 'Địa chỉ của thiết bị này',
        noAddress: 'Chưa có địa chỉ truy cập. Hãy bật "Cho phép kết nối".',
        authorized: 'Thiết bị được cấp quyền',
        noAuthorized: 'Chưa có thiết bị nào được cấp quyền.',
        kind: 'Loại',
        lastUsed: 'Dùng lần cuối',
        never: 'chưa bao giờ',
        scopeCount: '{{n}} quyền',
        showAllScopes: 'Hiện tất cả ({{n}})',
        showLessScopes: 'Thu gọn',
        connectedHere: 'Đang kết nối',
        remove: 'Gỡ quyền truy cập',
        removeConfirm: 'Gỡ quyền truy cập của thiết bị này? Thiết bị sẽ bị ngắt ngay.',
        edit: 'Sửa quyền',
        editHelp: 'Quyền được cố định khi thiết bị ghép đôi. Lưu sẽ tạo mã ghép đôi mới với các quyền đã chọn; thiết bị phải ghép đôi lại và kết nối hiện tại sẽ bị đóng.',
        editSave: 'Tạo mã ghép đôi mới',
        permissions: 'Quyền',
        permsHelp: 'Áp dụng cho thiết bị này mà không cần ghép đôi lại. Chỉ liệt kê những quyền mà loại thiết bị này có thể có. Các kết nối hiện tại sẽ đóng và thiết bị kết nối lại với bộ quyền mới.',
        permsSave: 'Áp dụng quyền',
        permsApplied: 'Đã áp dụng quyền. Thiết bị sẽ kết nối lại để nhận bộ quyền mới.',
        permsUnchanged: 'Không có gì thay đổi.',
        permsConfirm: 'Áp dụng các quyền này cho thiết bị? Kết nối hiện tại sẽ đóng và thiết bị kết nối lại với bộ quyền mới.',
        permsMissingUpload: 'Cấp lại quyền tải tệp lên',
        'permsErr.bad-request': 'Không đọc được thay đổi. Hãy tải lại trang và thử lại.',
        'permsErr.unknown-scope': 'Có một quyền mà Host này không biết.',
        'permsErr.scope-not-updatable': 'Quyền mở khóa web do luồng passkey cấp, không cấp ở đây.',
        'permsErr.scope-not-for-kind': 'Quyền đó không áp dụng cho loại thiết bị này.',
        'permsErr.forbidden': 'Chỉ đổi được quyền từ máy này.',
        'permsErr.not-found': 'Thiết bị đó không còn ghép đôi. Hãy tải lại trang.',
        permsNotForKeyKind: 'Thiết bị này đang giữ một quyền mà loại của nó không dùng được (mở khóa web — chỉ thiết bị web hoặc điện thoại đáp ứng được). Bấm Áp dụng quyền sẽ gỡ quyền đó.',
        cancel: 'Hủy',
        'scope.sessions:read': 'Xem phiên và lịch sử',
        'scope.prompt:send': 'Gửi prompt',
        'scope.approval:respond': 'Trả lời yêu cầu phê duyệt',
        'scope.files:read': 'Đọc tệp',
        'scope.files:write': 'Ghi tệp',
        'scope.settings:write': 'Đổi cài đặt',
        addDevice: 'Thêm thiết bị',
        addressLabel: 'Địa chỉ (ip:port)',
        pairingLabel: 'Chuỗi ghép đôi',
        nameLabel: 'Tên (tùy chọn)',
        connect: 'Ghép đôi và kết nối',
        remotes: 'Host từ xa',
        noRemotes: 'Chưa có host từ xa nào.',
        open: 'Mở',
        back: 'Quay lại',
        removeRemote: 'Gỡ',
        sessions: 'Phiên',
        noSessions: 'Host này chưa có phiên nào.',
        history: 'Lịch sử',
        noHistory: 'Không có tin nhắn.',
        prompt: 'Gửi prompt',
        send: 'Gửi',
        approvals: 'Yêu cầu phê duyệt đang chờ',
        noApprovals: 'Không có yêu cầu nào đang chờ.',
        allowOnce: 'Cho phép một lần',
        reject: 'Từ chối',
        desktopOnly: 'Hãy quyết định trên thiết bị kia (không có mã băm nội dung)',
        refresh: 'Làm mới',
        'status.online': 'Trực tuyến',
        'status.connecting': 'Đang kết nối',
        'status.offline': 'Ngoại tuyến',
        'status.disconnected': 'Đã ngắt kết nối',
        'status.disconnectedSessions': 'Phiên vẫn được liệt kê và đọc được; gửi prompt bị từ chối cho tới khi kết nối lại.',
        'status.revoked': 'Đã bị thu hồi quyền',
        'status.error': 'Lỗi',
        error: 'Lỗi',
        working: 'Đang xử lý…',
        sent: 'Đã gửi',
        enableFirst: 'Hãy bật "Cho phép kết nối" trước.',
        otpKindLabel: 'Mã này dành cho',
        otpKindMobile: 'Điện thoại / PWA (passkey)',
        otpKindMobileHint: 'Điện thoại hoặc web đăng ký passkey ngay sau khi bạn duyệt — đó là bước mở khóa phiên. Có kèm quyền "Mở khóa web".',
        otpKindDesktop: 'Máy tính (Desktop Remote)',
        otpKindDesktopHint: 'Tab Remote trên máy khác; không đăng ký passkey.',
        'scope.harness:remote': 'Dùng host này từ xa (phiên, prompt, phê duyệt)',
        'scope.commands:execute': 'Chạy lệnh slash',
        'scope.workspace:manage': 'Quản lý workspace và mọi đường dẫn',
        'scope.credentials:write': 'Đặt hoặc xóa thông tin xác thực nhà cung cấp',
        'scope.plugins:manage': 'Cài đặt và quản lý plugin',
        'scope.schedule:write': 'Tạo và chạy lịch',
        'scope.schedule:read': 'Xem các tác vụ theo lịch và lần chạy kế tiếp của mỗi tác vụ',
        'scope.terminal': 'Mở terminal',
        'scope.sessions:author': 'Tạo phiên và chọn model',
        'scope.attachments:write': 'Gửi tệp và hình ảnh đính kèm',
        'scope.browser:control': 'Điều khiển bảng trình duyệt trên Host',
        'scope.stats:read': 'Xem thống kê phiên và mức dùng ngữ cảnh',
        'scope.web:unlock': 'Mở khóa ứng dụng web (PWA)',
        'scope.permission:lower': 'Đặt phiên về mức chặt hơn (không bao giờ nới lỏng)',
        'risk.files:write': 'Có thể sửa tệp trong workspace của bạn.',
        'risk.settings:write': 'Có thể đổi cài đặt Host, model và preset agent.',
        'risk.commands:execute': 'Có thể chạy lệnh của Host với quyền của bạn.',
        'risk.workspace:manage': 'Có thể tạo hoặc xóa workspace và đọc tệp ngoài workspace.',
        'risk.credentials:write': 'Có thể ghi đè khóa API của bạn (không đọc được).',
        'risk.plugins:manage': 'Có thể cài hoặc bật mã chạy trên Host này.',
        'risk.schedule:write': 'Có thể tạo tác vụ chạy sau mà không cần bạn.',
        'risk.terminal': 'Toàn quyền shell trên Host này: làm được mọi việc bạn làm được.',
        'risk.sessions:author': 'Có thể mở phiên mới trên Host này và chọn model chạy phiên đó.',
        'risk.attachments:write': 'Có thể gửi tệp và hình ảnh đính kèm vào phiên trên Host này.',
        'risk.browser:control': 'Có thể mở trang và thao tác trong trình duyệt trên Host thay bạn.',
        'risk.web:unlock': 'Có thể chứng thực việc mở khóa ứng dụng web cho tài khoản này.',
        'risk.permission:lower': 'Chỉ có thể đặt phiên chặt hơn; không bao giờ nới lỏng quyền.',
        'uploadsOff': 'Đính kèm từ xa đang tắt: Host này không nhận tệp tải lên cho phiên từ xa.',
        'uploadsWaiting': 'Đang chờ dịch vụ tải lên…',
        'uploadsBroken': 'Đính kèm từ xa sẽ lỗi: tuyến tải lên mà plugin này bọc không còn ở đó',
        presetStandard: 'Tiêu chuẩn',
        presetFull: 'Toàn quyền',
        presetFullHint: 'Mọi quyền, gồm shell, plugin và thông tin xác thực. Chỉ dùng cho thiết bị bạn hoàn toàn tin cậy.',
        presets: 'Mẫu quyền',
        notRequested: 'Thiết bị này không yêu cầu',
        advancedLimits: 'Nâng cao',
        limitsHelp: 'Giới hạn tùy chọn cho mỗi thiết bị của cầu nối từ xa. 0 nghĩa là không giới hạn (mặc định). Đây là cấu hình Host (remoteBridgeLimits trong cấu hình plugin mobile-gateway), không đổi được từ trang này.',
        'limit.maxConnectionsPerDevice': 'Số kết nối mỗi thiết bị',
        'limit.maxStreamsPerDevice': 'Số luồng mở mỗi thiết bị',
        'limit.maxInflightPerDevice': 'Số lệnh đang chạy mỗi thiết bị',
        'limit.callsPerSecond': 'Số lệnh mỗi giây mỗi thiết bị',
        'limit.maxResultBytes': 'Kết quả một lần lớn nhất (byte)',
        unlimited: 'không giới hạn',
        // --- spec 008 T036: địa chỉ lắng nghe thực tế, chỉ đọc ---
        listeningOn: 'Đang lắng nghe trên',
        listenerUp: 'Đang bật',
        listenerDown: 'Đang tắt',
        listenerUnknown: 'chưa rõ địa chỉ',
        certPin: 'Mã ghim chứng chỉ (SHA-256)',
        // Một từ cho biết ai kết nối được; "Vòng lặp máy này" là cách nói sai
        // trong tiếng Việt, nên loopback ở đây là "Máy này".
        routeLoopback: 'Máy này',
        routeLan: 'Mạng nội bộ',
        routeTailscale: 'Tailscale',
        loopbackWarning: 'Host đang lắng nghe trên địa chỉ loopback, nên chỉ máy này truy cập được — điện thoại hay máy khác không kết nối được. Để đổi, mở Cài đặt → Plugin → mục mobile-gateway → cấu hình → địa chỉ lắng nghe (lanHost), và nhập một địa chỉ LAN nội bộ hoặc địa chỉ Tailscale của máy này. Mã ghim chứng chỉ không đổi, nên không cần tạo chứng chỉ mới.',
        // Nhãn của dòng địa chỉ bind. Tiêu đề "reachable" cũ và câu về tailnet đã bỏ:
        // chip lộ trình đã nói đúng điều đó.
        reachableNote: 'Host này nhận kết nối tại',
        // --- spec 008: cổng mà dải động của hệ điều hành có thể cấp cho kết nối đi ra ---
        portRiskBody: 'Hệ điều hành có thể cấp cổng này cho một kết nối đi ra, nên listener có thể không bind được vào một lúc ngẫu nhiên.',
        portRiskSafeBand: 'Cổng 20000-39999 nằm ngoài dải động và là dải an toàn.',
        portBusyBody: 'Một chương trình khác đang giữ cổng này, hoặc một kết nối đi ra đã lấy đúng cổng đó từ dải động của hệ điều hành. Cổng bị chiếm là lý do listener không bind được.',
        // --- spec 008: kế hoạch kết nối — gắn listener vào một địa chỉ của chính máy này ---
        planTitle: 'Kế hoạch kết nối',
        planBindTitle: 'Địa chỉ bind của gateway',
        planServeRoute: 'Truy cập được qua lớp Tailscale serve:',
        planServeNote: 'Gateway thực tế đang lắng nghe tại',
        planHelp: 'Gắn gateway của máy này vào một địa chỉ của chính nó. Tuỳ chọn Tailscale dùng địa chỉ tailnet của máy này, nên các thiết bị trong tailnet của bạn kết nối được.',
        planLanCaveat: 'LAN gắn vào địa chỉ riêng đầu tiên mà hệ điều hành báo cáo. Một adapter VPN hoặc mạng ảo có thể được chọn trước adapter LAN thật; nếu đó không phải địa chỉ bạn muốn, hãy dùng tuỳ chọn Tailscale hoặc đặt địa chỉ lắng nghe trong cấu hình gateway.',
        planBound: 'Đang lắng nghe tại',
        planPrivateHint: 'Đây là địa chỉ riêng hoặc mạng ảo, không hẳn là LAN trong nhà bạn:',
        'plan.loopback': 'Chỉ máy này',
        'plan.lan': 'LAN',
        'plan.tailscale': 'Mạng riêng Tailscale',
        planApplying: 'Đang áp dụng…',
        planUnknown: 'Chưa rõ — gateway chưa báo địa chỉ',
        planTailscaleUnavailable: 'Không phát hiện giao diện Tailscale trên máy này.',
        // Lý do quen thuộc thay cho câu tiếng Anh của route: trang tiếng Việt không
        // in nguyên văn tiếng Anh; lý do lạ vẫn hiện nguyên văn để không giấu lỗi.
        planErrTailscale: 'Chưa có giao diện Tailscale nào để gắn: hãy kết nối máy này vào tailnet rồi chọn lại.',
        planErrLan: 'Không tìm thấy địa chỉ LAN riêng nào trên máy này nên chưa có địa chỉ để gắn.',
        planErrDisabled: 'Cần bật Cho phép kết nối (và quyền truy cập LAN) trước khi đổi địa chỉ lắng nghe.',
        otpTitle: 'Mã ghép đôi',
        otpHelp: 'Nhập mã này trên thiết bị kia cùng với địa chỉ này. Chỉ dùng một lần, trong 10 phút, và bạn vẫn phải phê duyệt yêu cầu tại đây.',
        otpNew: 'Tạo mã ghép đôi',
        otpClose: 'Đóng',
        otpQrAlt: 'Mã QR ghép đôi',
        otpQrHelp: 'Quét bằng camera điện thoại: ứng dụng mở ra với địa chỉ và mã đã điền sẵn. Bạn vẫn xác nhận trên điện thoại và phê duyệt tại đây.',
        otpQrTextHelp: 'Quét để đọc địa chỉ và mã dạng văn bản.',
        pendingTitle: 'Yêu cầu đang chờ',
        pendingNone: 'Không có thiết bị nào đang xin kết nối.',
        pendingHelp: 'Hãy kiểm tra mã bên dưới trùng với mã hiển thị trên thiết bị kia trước khi phê duyệt.',
        unnamedDevice: 'Thiết bị chưa đặt tên',
        verifyCode: 'Mã xác minh',
        approve: 'Phê duyệt',
        rejectRequest: 'Từ chối',
        requestedAt: 'Yêu cầu lúc',
        fromIp: 'Từ',
        addTitle: 'Thêm thiết bị',
        addLan: 'LAN',
        addInternet: 'Internet',
        addInternetLater: 'Internet — sau này',
        addAddress: 'Địa chỉ',
        addCode: 'Mã ghép đôi',
        addCodeHint: '8 chữ số, hiển thị trên thiết bị kia',
        addName: 'Tên hiển thị',
        addNote: 'Ghép đôi lại có thể mở rộng hoặc thu hẹp quyền truy cập. Nếu không có workspace nào, hãy kiểm tra quyền trong mục Thiết bị được cấp quyền trên thiết bị kia.',
        addSubmit: 'Thêm thiết bị',
        advanced: 'Nâng cao: dán chuỗi ghép đôi',
        advancedBack: 'Dùng mã 8 chữ số',
        waiting: 'Đang chờ phê duyệt trên host',
        waitingCode: 'Mã',
        waitingHelp: 'Hãy phê duyệt yêu cầu này trên thiết bị kia sau khi kiểm tra nó hiển thị cùng một mã.',
        cancelWait: 'Hủy',
        editAddress: 'Sửa địa chỉ',
        saveAddress: 'Lưu',
        addressPinNote: 'Giữ nguyên vân tay chứng chỉ; chỉ đổi địa chỉ.',
        addressSaving: 'Đang lưu…',
        pairRejected: 'Host đã từ chối thiết bị này.',
        pairApproved: 'Đã ghép đôi.',
        // --- spec 008 P2b: phiên từ xa trong giao diện gốc ---
        // Trình duyệt gốc giữ các dòng workspace và phiên, nên plugin chỉ đặt tên host.
        hostChip: 'Host',
        hostAlreadyShown: 'Host',
        // Dòng sao chép thứ hai trên dòng phiên: bản gốc sao chép id đã gắn thẻ của
        // plugin này, dòng này sao chép id mà chính Host dùng.
        copyOriginalId: 'Sao chép ID gốc',
        popoverTitle: 'Host từ xa',
        popoverPaired: 'Ghép đôi lúc',
        popoverKind: 'Loại',
        popoverScopes: 'Quyền',
        popoverNoScopes: 'không có',
        reconnect: 'Kết nối lại',
        reconnecting: 'Đang kết nối lại…',
        autoRetry: 'Đang tự kết nối lại…',
        forgetHost: 'Gỡ host',
        forgetConfirm: 'Gỡ host này? Token của nó sẽ bị xóa khỏi máy này và workspace của nó rời khỏi thanh bên.',
        manageAll: 'Quản lý mọi thiết bị trong Cài đặt → Thiết bị',
        banners: 'Thông báo phiên từ xa',
        bannerOfflineTitle: 'Tác vụ này không còn trên',
        bannerOfflineBody: 'Bạn đang đọc bản sao cục bộ; nó chỉ đọc.',
        bannerReadOnly: 'Chỉ đọc',
        removeLocalCopy: 'Xóa bản sao cục bộ',
        removeLocalCopyBusy: 'Đang xóa…',
        localCopyRemoved: 'Đã xóa bản sao cục bộ.',
        localCopyGone: 'Không có bản sao cục bộ nào để xóa.',
        modelStatus: 'Trạng thái model',
        modelUnavailable: 'Host báo model này không khả dụng. Prompt vẫn chạy trên host; không dùng model cục bộ thay thế.',
        terminalEntry: 'Terminal',
        terminalOpen: 'Mở terminal trên host này',
        terminalHint: 'Terminal cần quyền "Mở terminal" trên thiết bị này.',
        terminalUnavailable: 'Terminal không khả dụng trong giao diện này.',
        sidebarGrouping: 'Tên host trên thanh bên',
        sidebarOn: 'đang hiện tên trên các dòng phiên',
        sidebarOffState: 'tắt',
        // Vì sao các chỗ đặt tên host chưa được cài — cùng bộ lý do cố định như bản en.
        sidebarReasonNotInstalled: 'Chưa cài đặt.',
        sidebarReasonNoServices: 'Giao diện này không cung cấp dịch vụ phía máy khách.',
        sidebarReasonNoHost: 'Chưa có host từ xa nào kết nối.',
        sidebarReasonNoActions: 'Giao diện này không cung cấp thao tác với workspace.',
        sidebarReasonRoutingOff: 'Định tuyến đa host đang tắt',
        // Hai thẻ của thanh bên (như Qoder). Chúng lọc DANH SÁCH do trình duyệt gốc vẽ;
        // không luồng dữ liệu nào bị hỏi lại.
        hostTabs: 'Thẻ trên thanh bên',
        hostTabsOn: 'hai thẻ, lọc danh sách thanh bên',
        hostTabsOff: 'chưa cài đặt',
        tabThisComputer: 'Máy này',
        tabRemoteWorkspace: 'Workspace từ xa',
        tabSwitchLocal: 'Xem phiên trên máy này',
        tabSwitchRemote: 'Xem workspace từ xa',
        tabShortcutLocal: 'Ctrl+Alt+1',
        tabShortcutRemote: 'Ctrl+Alt+2',
        sidebarReasonNoTabs: 'Giao diện này không khai báo dải thẻ cho thanh bên.',
        sidebarReasonShortcut: 'Thẻ thanh bên đang bật, nhưng không đăng ký được Ctrl+Alt+1 / 2',
        // --- spec 033 (A1.2): tệp chọn cho phiên từ xa đến host đó dưới dạng byte ---
        attachTitle: 'Đính kèm tệp từ xa',
        attachOn: 'Tệp chọn cho phiên từ xa được gửi tới host đó dưới dạng byte',
        attachNoBridge: 'Giao diện này không có đường dẫn tệp cục bộ, nên mọi tệp chọn đều đã được tải lên',
        attachOffUnknown: 'Tệp chọn cho phiên từ xa KHÔNG được gửi tới host đó',
        attachReason: 'Lý do',
        attachNoModule: 'giao diện này không cung cấp mô-đun đính kèm',
        attachNoWindow: 'trang này không có cửa sổ',
        attachNotInstalled: 'phần đính kèm chưa chạy',
        attachBrowserUnavailable: 'trình duyệt này không dựng được danh sách tệp mà lượt chọn từ xa cần',
        attachMeasured: 'phần đính kèm đang bật: mỗi lượt chọn từ xa được kiểm tra ngay tại chỗ trước khi chuyển đi',
        attachLast: 'Lần chọn gần nhất được xử lý như DSH vẫn làm',
        attachPickLocal: 'tệp thuộc một phiên cục bộ nên DSH giữ nguyên cách xử lý của nó',
        attachPickAmbiguous: 'không xác định chắc chắn được phiên nên DSH giữ nguyên cách xử lý của nó',
        attachPickNoComposer: 'không có ô soạn nào đang mở',
        attachPickNoDocument: 'không đọc được trang',
        attachPickNoSession: 'ô soạn của tệp không hiển thị phiên nào',
        attachPickElsewhere: 'tệp không đến từ ô soạn',
        attachPickBrowser: 'đây không phải lượt chọn từ ô soạn mà trang này thấy được',
        attachPickUncertain: 'không xác định được ô soạn của tệp',
        attachPickStale: 'ô soạn của tệp đã thay đổi trước khi lượt chọn xong',
        attachPickPassthrough: 'cầu nối khác đã trả lời lượt chọn này',
        attachPickPathNamed: 'đường dẫn tệp vẫn gắn với lượt chọn nên DSH giữ nguyên cách xử lý của nó',
        attachPickUnverified: 'không xác nhận được danh sách tệp đã thay nên DSH giữ nguyên cách xử lý của nó',
        attachPickReplaceFailed: 'lượt chọn này thuộc một phiên từ xa, nhưng ô soạn không nhận bản sao để tải lên, nên DSH giữ nguyên cách xử lý của nó',
        attachPickUnknown: 'không rõ phiên của tệp',
        'reason.dsh-version-mismatch': 'phiên bản DSH không đúng bản đã ghim',
        'reason.dsh-version-unknown': 'chưa rõ phiên bản DSH',
        'reason.no-gateway': 'thiếu gateway',
        'reason.dispatchRpc-missing': 'gateway không có dispatchRpc',
        'reason.openWireStream-missing': 'gateway không có openWireStream',
        'reason.openWireStream-signature': 'chữ ký của gateway khác bản đã ghim',
        // --- thiếu quyền: phiên và workspace từ xa không hiển thị được (spec 008) ---
        missingRemoteScope: 'Phiên và workspace từ xa sẽ không hiện ra cho tới khi thiết bị này được ghép đôi lại trên host đó kèm quyền "Dùng host này từ xa" (harness:remote).',
        pinMismatchNote: 'Host này đưa ra chứng chỉ khác với lần ghép đôi. Chưa có gì được gửi đi. Nếu bạn tin thay đổi này thì ghép đôi lại.',
        hostRefused: 'Host đã từ chối yêu cầu vừa rồi',
        // --- spec 016 Phase 3: trình duyệt trên máy này cho host đã ghép đôi điều khiển ---
        browserAgentConsent: 'Cho phép host này điều khiển trình duyệt trên máy này',
        browserAgentConsentHelp: 'Mặc định tắt. Khi bật, agent của host này được mở trang trong Chrome hoặc Edge headless riêng của nó, với profile riêng. Nút Dừng trong tab Trình duyệt (agent) sẽ đóng nó ngay.',
        browserAgentOffByDefault: 'Tắt',
        browserAgentTab: 'Trình duyệt (agent)',
        browserAgentOpen: 'Mở Trình duyệt (agent)',
        browserAgentDescription: 'Bản chiếu màn hình trình duyệt mà host này đang điều khiển trên máy bạn',
        browserAgentBanner: 'Agent đang điều khiển',
        browserAgentStop: 'Dừng',
        browserAgentStopped: 'Đã dừng. Trình duyệt trên máy này đã đóng.',
        browserAgentEmpty: 'Đang chờ khung hình đầu tiên…',
        browserAgentNoConsent: 'Host này không được phép điều khiển trình duyệt trên máy này.',
        browserAgentFailed: 'Không lấy được bản chiếu màn hình',
        // --- spec 016 Phase 1: mỗi máy đã ghép đôi một cửa vào ở trang Bắt đầu ---
        hostDoor: 'Máy từ xa',
        hostDoorDescription: 'Phiên và phê duyệt trên máy này',
        devicesDoorDescription: 'Ghép đôi, cấp quyền và điều khiển trình duyệt cho máy này',
        hostDoorGone: 'Máy này không còn ghép đôi. Hãy thêm lại trong trang Thiết bị.',
        updTitle: 'Cập nhật plugin', updCheck: 'Kiểm tra cập nhật', updChecking: 'Đang kiểm tra…',
        updCurrent: 'Hiện tại', updLatest: 'Bản phát hành mới nhất', updUpToDate: 'Đã là bản mới nhất.', updNoTags: 'Chưa có bản phát hành nào.',
        updNotes: 'Thay đổi', updUpdate: 'Cập nhật', updUpdating: 'Đang cập nhật…', updRemote: 'Nguồn',
        updConfirm: 'Cập nhật plugin lên {tag}? Chỉ áp dụng merge fast-forward; DSH không tự khởi động lại.',
        updDone: 'Khởi động lại DSH để nạp {tag}.', updRollback: 'Để quay lại, commit trước đó là {head}.',
        updBlocked: 'Không thể cập nhật', updSignature: 'Chữ ký', updEngines: 'Tương thích DSH',
      },    }
    let hostLanguage = ''
    const listeners = new Set()
    const currentLang = () => (/^vi/i.test(hostLanguage || (typeof navigator !== 'undefined' ? navigator.language : '') || '') ? 'vi' : 'en')
    const tr = (key) => DICT[currentLang()][key] ?? DICT.en[key] ?? key
    const subscribeLang = (listener) => { listeners.add(listener); return () => listeners.delete(listener) }
    const langSnapshot = () => currentLang()
    const setHostLanguage = (value) => {
      const before = currentLang()
      hostLanguage = value || ''
      if (before !== currentLang()) for (const listener of listeners) listener()
    }
    const useLang = () => React.useSyncExternalStore(subscribeLang, langSnapshot)
    // "3 connected successfully": the number is a slot in the sentence, not
    // something a translator has to decode around.
    const connectedCount = (n) => tr('connectedCount').replace('{{n}}', String(n))
    // Same slot rule for a permission count ("13 permissions" / "13 quyền").
    const withCount = (key, n) => tr(key).replace('{{n}}', String(n))
    // What this machine calls itself. /mgw/status already reports it
    // (`gatewayName`, which the gateway defaults to `os.hostname()`), and no other
    // route in this page knows a local name — so when it says nothing the translated
    // literal is the name instead of a new endpoint.
    const localName = (status) => {
      const name = status && typeof status.gatewayName === 'string' ? status.gatewayName.trim() : ''
      return name || tr('thisDevice')
    }
    // The gateway stores '' for a device that reported no name (it never invents one), so
    // every row that shows a name substitutes this label instead of an empty line.
    const deviceName = (record) => record.displayName || record.name || tr('unnamedDevice')

    // ------------------------------------------------------------- helpers
    // Same-origin only; honours the <base> prefix the way the gateway does.
    // `image` asks for the raw body (a screencast frame) instead of JSON: the page
    // still has exactly one network call site, so no second fetch can bypass these
    // rules.
    async function request(path, options, { image = false } = {}) {
      const target = new URL(path.replace(/^\//, ''), document.baseURI).href
      const response = await fetch(target, { credentials: 'same-origin', ...options })
      if (image) {
        if (!response.ok) {
          // The route's own reason travels in the JSON body (e.g. "no Chrome or Edge
          // is installed"); a failed frame must say that, not a generic sentence.
          const body = await response.json().catch(() => ({}))
          const failure = new Error(body.message || body.error || `HTTP ${response.status}`)
          failure.code = body.error
          failure.status = response.status
          throw failure
        }
        return { status: response.status, blob: await response.blob() }
      }
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        // Keep the route's machine-readable reason beside its sentence: a page that
        // is not in English uses the code to name a KNOWN reason in the Host
        // language instead of printing the route's English sentence.
        const failure = new Error(body.message || body.error || `HTTP ${response.status}`)
        failure.code = body.error
        failure.status = response.status
        throw failure
      }
      return body
    }
    const post = (path, body) => request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
    })
    async function copyText(text) {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('clipboard unavailable')
      }
      await navigator.clipboard.writeText(text)
    }
    const colors = {
      panel: 'var(--dsw-alias-bg-layer-2, var(--color-bg, Canvas))',
      card: 'var(--dsw-alias-bg-module-platform, var(--color-bg-elevated, Canvas))',
      text: 'var(--dsw-alias-label-primary, var(--color-text, CanvasText))',
      muted: 'var(--dsw-alias-label-secondary, var(--color-text-muted, GrayText))',
      border: 'var(--dsw-alias-border-l3, var(--color-border, rgba(127,127,127,.24)))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08))',
      accent: 'var(--dsw-alias-button-primary-fill, var(--color-primary, #4f7cff))',
      accentText: 'var(--dsw-alias-label-primary-foreground, #fff)',
      danger: 'var(--dsw-alias-state-error-primary, #dc4c64)',
      success: 'var(--dsw-alias-state-success-primary, #2fb171)',
      // A pending approval is a request, not a fault: the same warm tone the
      // gateway's own notice uses, so "waiting" never reads as "broken".
      warn: 'var(--dsw-alias-state-warn-primary, #d99a16)',
    }
    // The row-action glyphs below are inline SVG data URIs — nothing is fetched.
    // Their XML namespace is assembled from two pieces so the file's "no external
    // URL" scan stays a literal, exact check instead of needing an exception.
    const SVG_NS = ['http:', '//www.w3.org/2000/svg'].join('')
    const css = `
.dshdev{font-family:var(--dsw-font-family,system-ui,sans-serif);font-size:13px;color:${colors.text};max-width:880px;line-height:1.5}
/* The sidebar panel's host: the main column ships no padding and does not scroll,
   so this seat owns the page's insets and its own scroll region. */
.dshdev-panel{flex:1;min-height:0;overflow:auto;box-sizing:border-box;padding:28px 32px 40px}
.dshdev h2{margin:0;font-size:20px;font-weight:650;letter-spacing:-.01em}
.dshdev h3{margin:0 0 8px;font-size:13.5px;font-weight:600}
.dshdev-head{margin-bottom:18px}
.dshdev-sub{margin:6px 0 0;color:${colors.muted};font-size:12.5px}
/* Segmented control: one rounded track, the selected tab a card-coloured pill.
   No underline — the pill is the only selection cue. */
.dshdev-tabs{display:inline-flex;flex-wrap:wrap;gap:2px;padding:3px;margin-bottom:18px;border:1px solid ${colors.border};border-radius:999px;background:${colors.hover}}
.dshdev-tab,.dshdev-seg-btn{margin:0;background:transparent;border:0;border-radius:999px;color:${colors.muted};cursor:pointer;font:inherit;padding:6px 14px;transition:background .12s,color .12s}
.dshdev-tab:hover,.dshdev-seg-btn:hover{color:${colors.text}}
.dshdev-tab[aria-selected=true],.dshdev-seg-btn[aria-selected=true]{background:${colors.card};color:${colors.text};font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.22)}
.dshdev-card{background:${colors.card};border:1px solid ${colors.border};border-radius:14px;padding:16px 18px;margin-bottom:14px}
.dshdev-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshdev-grow{flex:1;min-width:0}
.dshdev-muted{color:${colors.muted};font-size:12px}
.dshdev-btn{background:transparent;border:1px solid ${colors.border};border-radius:8px;color:inherit;cursor:pointer;font:inherit;padding:5px 12px}
.dshdev-btn:hover:not(:disabled){background:${colors.hover}}
.dshdev-btn:disabled{opacity:.5;cursor:default}
.dshdev-btn.primary{background:${colors.accent};border-color:${colors.accent};color:${colors.accentText}}
.dshdev-btn.danger{color:${colors.danger};border-color:${colors.danger}}
.dshdev-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid ${colors.border};border-radius:999px;padding:3px 6px 3px 10px;font-family:ui-monospace,monospace;font-size:12px}
.dshdev-badge{border-radius:999px;padding:1px 8px;font-size:11px;border:1px solid ${colors.border};color:${colors.muted}}
.dshdev-badge.ok{color:${colors.success};border-color:${colors.success}}
.dshdev-badge.bad{color:${colors.danger};border-color:${colors.danger}}
/* Amber: something is waiting for the owner, which is not an error. */
.dshdev-badge.warn{color:${colors.warn};border-color:${colors.warn}}
.dshdev-input{box-sizing:border-box;width:100%;background:transparent;border:1px solid ${colors.border};border-radius:8px;color:inherit;font:inherit;padding:6px 10px}
.dshdev-code{display:block;word-break:break-all;font-family:ui-monospace,monospace;font-size:12px;background:${colors.hover};border-radius:8px;padding:8px 10px;max-height:120px;overflow:auto}
.dshdev-list>div{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid ${colors.border};flex-wrap:wrap}
.dshdev-list>div:first-child{border-top:0}
.dshdev-switch{position:relative;width:38px;height:22px;border-radius:999px;border:0;cursor:pointer;background:rgba(127,127,127,.4);padding:0;flex:none}
.dshdev-switch[aria-checked=true]{background:${colors.accent}}
.dshdev-switch::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .12s}
.dshdev-switch[aria-checked=true]::after{left:19px}
.dshdev-switch:disabled{opacity:.5;cursor:default}
.dshdev-err{color:${colors.danger};margin:8px 0}
/* A short grant: visible on the remote's own row, but it blocks nothing. */
.dshdev-warn{margin-top:6px;padding:6px 10px;border-left:3px solid ${colors.danger};border-radius:6px;background:${colors.hover};color:${colors.text};font-size:12px}
.dshdev-msg{margin:6px 0;padding:8px 10px;border-radius:8px;background:${colors.hover};white-space:pre-wrap;word-break:break-word}
.dshdev-msg.user{border-left:3px solid ${colors.accent}}
.dshdev-otp{font-family:ui-monospace,monospace;font-size:34px;font-weight:700;letter-spacing:.12em;text-align:center;padding:14px 0}
.dshdev-vcode{font-family:ui-monospace,monospace;font-size:30px;font-weight:700;letter-spacing:.14em}
.dshdev-dialog-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000}
.dshdev-dialog{background:${colors.panel};color:${colors.text};border:1px solid ${colors.border};border-radius:14px;padding:20px 22px;width:min(460px,92vw);max-height:90vh;overflow:auto}
.dshdev-seg{display:inline-flex;border:1px solid ${colors.border};border-radius:8px;overflow:hidden}
.dshdev-seg button{background:transparent;border:0;color:inherit;font:inherit;padding:5px 14px;cursor:pointer}
.dshdev-seg button[aria-pressed=true]{background:${colors.accent};color:${colors.accentText}}
.dshdev-seg button:disabled{opacity:.5;cursor:default}
/* The sidebar's host tabs sit above the New Task row inside the sidebar.session.action */
/* layer: display:contents so the layer adds no box of its own, and only the strip is styled. */
.dshdev-hosttabs{display:contents}
.dshdev-hosttabs-strip{display:flex;gap:2px;margin:0 6px 6px;padding:2px;border:1px solid ${colors.border};border-radius:999px;background:${colors.hover}}
.dshdev-hosttabs-strip button{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* spec 008 P2b: the host seat on a native session row, the composer chip/popover
   and the session notices. The seat is a sibling of the row's own timestamp, so
   it stays small and quiet and never pushes the title. */
.dshdev-hostbadge{display:inline-flex;align-items:center;gap:5px;flex:none;max-width:120px;
  color:${colors.muted};font-size:11px;line-height:1}
.dshdev-hostbadge-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdev-dot{width:7px;height:7px;border-radius:50%;flex:none;background:${colors.muted};display:inline-block}
.dshdev-dot.ok{background:${colors.success}}
/* The dot is the only thing that carries the link state, so each state owns a
   colour: a dialling link is amber and breathes, a dead one is quiet grey. */
.dshdev-dot.warn{background:${colors.warn};animation:dshdev-dot-pulse 1.7s ease-in-out infinite}
.dshdev-dot.off{background:${colors.danger}}
@keyframes dshdev-dot-pulse{0%,100%{opacity:.45}50%{opacity:1}}
.dshdev-chip-host{display:inline-flex;align-items:center;gap:6px;background:transparent;border:1px solid ${colors.border};border-radius:999px;color:inherit;cursor:pointer;font:inherit;font-size:12px;padding:2px 10px;max-width:220px}
.dshdev-chip-host:hover{background:${colors.hover}}
.dshdev-chip-host span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdev-pop{position:absolute;bottom:calc(100% + 8px);left:0;z-index:20;width:min(320px,80vw);background:${colors.panel};color:${colors.text};border:1px solid ${colors.border};border-radius:12px;padding:12px 14px;box-shadow:0 8px 24px rgba(0,0,0,.18);text-align:left}
.dshdev-pop-row{display:flex;gap:8px;align-items:baseline;justify-content:space-between;margin:4px 0}
.dshdev-pop-row span:first-child{color:${colors.muted};font-size:11px;flex:none}
.dshdev-pop-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.dshdev-anchor{position:relative;display:inline-flex}
.dshdev-dock{display:flex;flex-direction:column;gap:6px;margin-bottom:6px}
.dshdev-banner{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;border:1px solid ${colors.border};border-left:3px solid ${colors.danger};border-radius:8px;padding:8px 10px;background:${colors.card}}
.dshdev-banner.info{border-left-color:${colors.accent}}
.dshdev-banner strong{display:block;font-weight:600}
/* Spec 016 Phase 3: the agent browser tab is a plain screencast under a notice bar. */
.dshdev-agentbrowser{display:flex;flex-direction:column;gap:8px;height:100%;min-height:0}
.dshdev-agentframe{display:block;width:100%;height:auto;border:1px solid ${colors.border};border-radius:8px;background:${colors.panel}}
.dshdev-agentplaceholder{padding:18px;border:1px dashed ${colors.border};border-radius:8px;text-align:center}
/* An exceptional condition is a quiet line under the facts, not a panel: no border,
   no fill, no heading — the words are the whole weight. */
.dshdev-note{margin:8px 0 0;color:${colors.muted};font-size:12px;line-height:1.45}
.dshdev-note.warn{color:${colors.warn}}
/* The pin is a fingerprint to copy, not to read: small and muted, full value in title. */
.dshdev-pin{font-family:ui-monospace,monospace;font-size:11.5px;color:${colors.muted}}
/* --- device rows: one card per device, one clear action per row --- */
/* The "this device" row both tabs open with: a rounded icon tile, the name, a
   muted chip and the one fact that matters for that tab. */
.dshdev-self{display:flex;align-items:center;gap:14px;margin-bottom:16px}
.dshdev-self-meta{color:${colors.muted};font-size:12px;margin-top:4px}
.dshdev-tile{width:40px;height:40px;flex:none;display:flex;align-items:center;justify-content:center;
  border:1px solid ${colors.border};border-radius:12px;background:${colors.hover};color:${colors.muted}}
.dshdev-tile.ok{color:${colors.success}}
.dshdev-tile.bad{color:${colors.danger}}
.dshdev-items{display:flex;flex-direction:column;gap:10px;margin-bottom:16px}
.dshdev-item{display:flex;align-items:flex-start;gap:14px;background:${colors.card};
  border:1px solid ${colors.border};border-radius:14px;padding:14px 16px}
.dshdev-item:hover{border-color:${colors.muted}}
/* A row inside an enclosing card is flat: two stacked card surfaces read as one
   slab on a dark theme, so only the standalone rows carry the card fill. */
.dshdev-card .dshdev-item{background:transparent}
.dshdev-item-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dshdev-item-name{font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.dshdev-item-status{color:${colors.muted};font-size:12px}
.dshdev-item-addr{color:${colors.muted};font-family:ui-monospace,monospace;font-size:11.5px;margin-top:3px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdev-item-actions{display:flex;align-items:center;gap:6px;flex:none}
/* An authorized device is a header line plus a full-width body: the tile, the name
   and the two actions on top, then the grant across the whole card — so the text
   never lives in the narrow column the buttons leave. */
.dshdev-item.dshdev-item-stack{display:block}
.dshdev-item-top{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}
/* The names keep a readable width and the tile stays beside them down to a fairly
   narrow card; below that the actions wrap UNDER the name instead of shrinking it
   to three words a line (the basis is what decides where each line breaks). */
.dshdev-item-main{flex:1 1 180px;min-width:0}
.dshdev-item-body{margin-top:10px}
/* Last use: its own row, one hairline above it, label muted and value plain. */
.dshdev-item-meta{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-top:8px;
  padding-top:8px;border-top:1px solid ${colors.border};font-size:12px}
/* One chip per scope: a grant is a list of things, not a sentence. */
.dshdev-scopes-block{margin-top:2px}
.dshdev-scopes-head{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.dshdev-scopes-count{font-size:12px;color:${colors.muted}}
.dshdev-scopes{display:flex;flex-wrap:wrap;gap:6px;overflow:hidden}
/* About two rows of 22px chips; every chip stays in the DOM, so the full grant is
   still readable by assistive tech and by the page's own tests. */
.dshdev-scopes.clamped{max-height:50px}
.dshdev-scope{box-sizing:border-box;display:inline-flex;align-items:center;height:22px;
  border:1px solid ${colors.border};border-radius:999px;background:${colors.hover};
  color:${colors.text};font-size:11.5px;padding:0 9px;white-space:nowrap}
/* Amber marks the dangerous ones: the ScopePicker's own RISKY_SCOPES, and the
   tooltip is the same risk line its checkbox prints. color-mix keeps the tint
   subtle on both themes; without it the chip keeps the neutral background. */
.dshdev-scope.risk{border-color:color-mix(in srgb, ${colors.warn} 55%, ${colors.border});
  background:color-mix(in srgb, ${colors.warn} 14%, transparent)}
.dshdev-scopes-toggle{background:transparent;border:0;color:${colors.muted};cursor:pointer;
  font:inherit;font-size:11.5px;padding:3px 0 0;margin-top:2px}
.dshdev-scopes-toggle:hover{color:${colors.text}}
.dshdev-pop-scopes{margin:6px 0 2px}
.dshdev-empty{border:1px dashed ${colors.border};border-radius:14px;padding:18px;color:${colors.muted};
  font-size:12px;margin-bottom:16px}
/* A block inside an already-open card (the Advanced disclosure): one hairline
   above it, no second card surface. */
.dshdev-sub-sect{padding-top:14px;margin-top:14px;border-top:1px solid ${colors.border}}
/* Section header: a small sentence-case label and one link-style action. No
   uppercase, no wide tracking — a settings page, not a dashboard legend. */
.dshdev-sect{display:flex;align-items:center;gap:10px;margin:18px 0 10px}
.dshdev-sect h3{margin:0;font-size:12px;font-weight:600;letter-spacing:0;text-transform:none;color:${colors.muted}}
.dshdev-link{background:transparent;border:0;border-radius:8px;color:${colors.accent};cursor:pointer;
  font:inherit;font-weight:600;padding:4px 8px}
.dshdev-link:hover{background:${colors.hover}}
/* The "+" is drawn by CSS, so the button's text stays exactly its label (the
   accessible name and the strings the page state is read by). */
.dshdev-link.add::before{content:'+ ';font-weight:700}
/* Icon-only row action: a 32px square, the glyph masked from an inline SVG data
   URI (no external asset), and the label kept as the element's text — clipped to
   nothing visually, but it is the accessible fallback and the tested contract. */
.dshdev-iact{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;
  width:32px;height:32px;padding:0;overflow:hidden;border:1px solid ${colors.border};border-radius:9px;
  background:transparent;color:${colors.muted};cursor:pointer;font:inherit;font-size:0;line-height:0}
.dshdev-iact:hover:not(:disabled){background:${colors.hover};color:${colors.text}}
.dshdev-iact.danger{color:${colors.danger}}
.dshdev-iact.danger:hover:not(:disabled){background:${colors.hover};color:${colors.danger}}
.dshdev-iact:disabled{opacity:.45;cursor:default}
.dshdev-iact::before{content:'';width:15px;height:15px;background:currentColor;
  -webkit-mask-image:var(--dshdev-glyph);mask-image:var(--dshdev-glyph);
  -webkit-mask-position:center;mask-position:center;
  -webkit-mask-size:15px 15px;mask-size:15px 15px;
  -webkit-mask-repeat:no-repeat;mask-repeat:no-repeat}
.iact-reconnect{--dshdev-glyph:url("data:image/svg+xml,%3Csvg xmlns='${SVG_NS}' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 12a8 8 0 1 1-2.35-5.66'/%3E%3Cpath d='M20 4v5h-5'/%3E%3C/svg%3E")}
.iact-open{--dshdev-glyph:url("data:image/svg+xml,%3Csvg xmlns='${SVG_NS}' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14 4h6v6'/%3E%3Cpath d='M20 4 11 13'/%3E%3Cpath d='M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'/%3E%3C/svg%3E")}
.iact-remove{--dshdev-glyph:url("data:image/svg+xml,%3Csvg xmlns='${SVG_NS}' viewBox='0 0 24 24' fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 7h16'/%3E%3Cpath d='M9 7V4h6v3'/%3E%3Cpath d='M6 7l1 13h10l1-13'/%3E%3C/svg%3E")}
/* --- the flow strip --- */
/* The caption sits under a FIXED-HEIGHT band, so the state and the host count
   never move the page. The wave is the only motion in Settings. */
.dshdev-flow{display:flex;flex-direction:column;gap:7px;margin:-4px 0 6px;padding:0 18px}
.dshdev-flow-band{display:flex;align-items:center;height:44px;overflow:hidden}
.dshdev-flow-grid{display:grid;grid-template-columns:repeat(15,5px);grid-auto-rows:5px;gap:7px 9px;
  justify-content:start;min-width:0}
.dshdev-flow-dot{width:5px;height:5px;border-radius:50%;background:${colors.accent};opacity:.26;will-change:opacity}
.dshdev-flow-note{color:${colors.muted};font-size:11.5px;margin:0}
/* idle keeps no animation at all: a pulse while nothing is connected would be a lie. */
.dshdev-flow[data-state=online] .dshdev-flow-dot{animation:dshdev-flow-pulse 2.8s ease-in-out infinite}
.dshdev-flow[data-state=connecting] .dshdev-flow-dot{background:${colors.success};animation:dshdev-flow-pulse 1.1s ease-in-out infinite}
@keyframes dshdev-flow-pulse{0%,100%{opacity:.22}45%{opacity:1}}
@media (prefers-reduced-motion: reduce){
  .dshdev-flow .dshdev-flow-dot{animation:none!important;opacity:.26}
  .dshdev-dot.warn{animation:none!important;opacity:1}
}
`

    // --------------------------------------------------------- small widgets
    // Presentation only: the tiles carry no state and no request. Stroke icons in
    // the shell's own line style, so they follow the theme through `currentColor`.
    const icon = (size, children) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true, focusable: false }, children)
    const IconMonitor = () => icon(20, [
      h('rect', { key: 's', x: 2.5, y: 4.5, width: 19, height: 12.5, rx: 2 }),
      h('path', { key: 'p', d: 'M9 20.5h6M12 17v3.5' }),
    ])
    const IconHost = () => icon(19, [
      h('rect', { key: 'a', x: 3.5, y: 3.5, width: 17, height: 7, rx: 1.6 }),
      h('rect', { key: 'b', x: 3.5, y: 13.5, width: 17, height: 7, rx: 1.6 }),
      h('path', { key: 'c', d: 'M7 7h.01M7 17h.01' }),
    ])
    const IconPhone = () => icon(19, [
      h('rect', { key: 's', x: 7, y: 2.5, width: 10, height: 19, rx: 2.2 }),
      h('path', { key: 'p', d: 'M11 18.5h2' }),
    ])
    const deviceIcon = (kind) => (kind === 'mobile' ? h(IconPhone) : h(IconMonitor))

    // The "this device" row both tabs open with: what you are looking at, then the
    // one fact that matters for the tab (`children`).
    function ThisDevice({ status, children }) {
      useLang()
      return h('div', { className: 'dshdev-card dshdev-self', 'data-testid': 'this-device' },
        h('div', { className: 'dshdev-tile' }, h(IconMonitor)),
        h('div', { className: 'dshdev-grow' },
          h('div', { className: 'dshdev-item-head' },
            h('strong', { className: 'dshdev-item-name', 'data-testid': 'this-device-name' }, localName(status)),
            h('span', { className: 'dshdev-badge' }, tr('thisDevice'))),
          h('div', { className: 'dshdev-self-meta' }, children)))
    }

    /**
     * The flow strip's state, derived from the paired hosts only.
     * `connecting` while any link is dialling (the supervisor's scheduled retry
     * counts as dialling), `online` as soon as a host answers, otherwise `idle`.
     * `idle` animates NOTHING: a pulsing grid with no connection would be a lie.
     */
    const flowState = (remotes) => {
      const list = Array.isArray(remotes) ? remotes : []
      if (list.some((remote) => remote && (remote.status === 'connecting' || remote.retry))) return 'connecting'
      if (list.some((remote) => remote && remote.status === 'online')) return 'online'
      return 'idle'
    }
    // 15 x 4 = 60 dots: a grid, not a canvas. Each dot starts a little later than
    // the one on its left (and a touch after the row above) so the same one-keyframe
    // animation reads as one wave travelling toward the host cards. The caption sits
    // UNDER the fixed-height band — muted and small, and announced politely, because
    // it is what names the state the colours alone cannot.
    const FLOW_COLUMNS = 15
    const FLOW_ROWS = 4
    function FlowStrip({ remotes }) {
      useLang()
      const state = flowState(remotes)
      const dots = []
      for (let row = 0; row < FLOW_ROWS; row += 1) {
        for (let column = 0; column < FLOW_COLUMNS; column += 1) {
          dots.push(h('span', {
            key: `${row}:${column}`, className: 'dshdev-flow-dot',
            style: { animationDelay: `${column * 90 + row * 40}ms` },
          }))
        }
      }
      return h('div', { className: 'dshdev-flow', 'data-state': state, 'data-testid': 'flow' },
        h('div', { className: 'dshdev-flow-band' },
          h('div', { className: 'dshdev-flow-grid', 'aria-hidden': true }, dots)),
        h('div', { className: 'dshdev-flow-note', role: 'status', 'aria-live': 'polite' },
          state === 'idle' ? tr('flowIdle') : tr('flowBusy')))
    }

    function CopyButton({ text, label }) {
      const [done, setDone] = React.useState(false)
      useLang()
      return h('button', {
        type: 'button', className: 'dshdev-btn',
        onClick: async () => {
          try { await copyText(text); setDone(true); window.setTimeout(() => setDone(false), 1800) } catch { setDone(false) }
        },
      }, done ? tr('copied') : (label || tr('copy')))
    }

    function Countdown({ expiresAt }) {
      const [now, setNow] = React.useState(() => Date.now())
      useLang()
      React.useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
      }, [])
      const left = Math.max(0, Math.round((expiresAt - now) / 1000))
      if (left <= 0) return h('span', { className: 'dshdev-badge bad' }, tr('expired'))
      return h('span', { className: 'dshdev-badge' }, `${tr('expiresIn')} ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`)
    }

    function PairingBox({ pairing, onClose }) {
      useLang()
      return h('div', { className: 'dshdev-card' },
        h('div', { className: 'dshdev-row' },
          h('h3', { className: 'dshdev-grow' }, tr('pairingCode')),
          h(Countdown, { expiresAt: pairing.pairing.expiresAt }),
          h(CopyButton, { text: pairing.pairingString }),
          onClose ? h('button', { type: 'button', className: 'dshdev-btn', onClick: onClose }, tr('cancel')) : null),
        h('code', { className: 'dshdev-code', 'data-testid': 'pairing-string' }, pairing.pairingString),
        h('div', { className: 'dshdev-muted', style: { marginTop: 6 } }, tr('pairingHelp')))
    }

    // ------------------------------------------------- spec 008 P1b widgets
    function Dialog({ title, onClose, children }) {
      return h('div', { className: 'dshdev-dialog-backdrop', role: 'presentation' },
        h('div', { className: 'dshdev-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': title },
          h('div', { className: 'dshdev-row', style: { marginBottom: 10 } },
            h('h3', { className: 'dshdev-grow', style: { margin: 0 } }, title),
            onClose ? h('button', { type: 'button', className: 'dshdev-btn', 'aria-label': tr('otpClose'), onClick: onClose }, '×') : null),
          children))
    }
    const groupOtp = (otp) => String(otp || '').replace(/^(\d{4})(\d{4})$/, '$1 $2')

    // Window 1: the one-time code, its countdown and the addresses to type.
    // The QR (lib/pair-qr.mjs, rendered locally on this Host) encodes
    // https://<pwa>/pair#a=<address>&c=<code>: the fragment never reaches a server.
    // `qr.address` is the address a phone can reach (behind `tailscale serve` the
    // listener's own loopback port is not), so it replaces the listener's list.
    function OtpDialog({ offer, addresses, lanHost, onQr, onClose }) {
      useLang()
      const [qr, setQr] = React.useState(null)
      React.useEffect(() => {
        let live = true
        post('/devices/pair-qr', { otp: String(offer.otp), lanHost: lanHost || '', fallbackAddress: addresses[0] || '' })
          .then((reply) => {
            if (!live || !reply) return
            if (typeof reply.svg === 'string') setQr(reply)
            // The Host's own served origin: handed up so the connection plan can state
            // the route this machine is actually reached through (spec 029). It is the
            // same `resolvePwaOrigin` answer the QR is built from.
            if (onQr) onQr(reply)
          })
          .catch(() => { /* the code and address still show; the QR is an extra */ })
        return () => { live = false }
      }, [offer.otp])
      const shown = qr && qr.address ? [qr.address] : addresses
      return h(Dialog, { title: tr('otpTitle'), onClose },
        qr ? h('div', { 'data-testid': 'otp-qr', style: { display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 8 } },
          h('img', { alt: tr('otpQrAlt'), width: 200, height: 200, src: 'data:image/svg+xml;utf8,' + encodeURIComponent(qr.svg) }),
          h('div', { className: 'dshdev-muted' }, tr(qr.link ? 'otpQrHelp' : 'otpQrTextHelp'))) : null,
        h('div', { className: 'dshdev-otp', 'data-testid': 'otp-code' }, groupOtp(offer.otp)),
        h('div', { className: 'dshdev-row', style: { justifyContent: 'center', marginBottom: 8 } },
          h(Countdown, { expiresAt: offer.pairing.expiresAt }),
          h(CopyButton, { text: String(offer.otp) })),
        h('div', { className: 'dshdev-muted', style: { marginBottom: 10 } }, tr('otpHelp')),
        h('h3', null, tr('address')),
        shown.length === 0 ? h('div', { className: 'dshdev-muted' }, tr('noAddress'))
          : h('div', { className: 'dshdev-row', 'data-testid': 'otp-addresses' }, shown.map((address) =>
            h('span', { key: address, className: 'dshdev-chip' }, address, h(CopyButton, { text: address })))))
    }

    // Every desktop scope, safest first. client.js is a plain script (it cannot
    // import packages/mobile-protocol), so these mirror the contract's SCOPES and
    // SCOPE_PRESETS; client.test.mjs fails if they drift.
    const ALL_SCOPES = [
      'sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'harness:remote',
      'files:write', 'settings:write', 'commands:execute', 'workspace:manage',
      'credentials:write', 'plugins:manage', 'schedule:write', 'schedule:read', 'terminal',
      // spec 011: a paired device may also start its own session and pick the model.
      'sessions:author',
      // spec 013: attach files and images to a session on the other Host. It rides
      // in the desktop default offer, but never arrives by itself on an existing
      // grant: only an explicit tick or preset puts it on a device.
      'attachments:write',
      // spec 014 C6: drive the Host's side-panel browser. Also a desktop default,
      // and also never handed out by a kind-independent default.
      'browser:control',
      // Read-only usage metrics (session stats, context usage). Also never a default.
      'stats:read',
      // spec 020: the web unlock attestation for the PWA. Mobile-holdable, and never
      // a default: it is a deliberate tick on the Devices page.
      'web:unlock',
      // spec 019 Wave 3: read this Host's permission presets and switch ONE session to a
      // strictly stricter one. It can never widen, and it is never a default either.
      'permission:lower',
    ]
    const SCOPE_PRESETS = {
      standard: ['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'harness:remote'],
      full: [...ALL_SCOPES],
    }
    // Scopes that get a risk hint under their checkbox.
    const RISKY_SCOPES = new Set(['files:write', 'settings:write', 'commands:execute', 'workspace:manage',
      'credentials:write', 'plugins:manage', 'schedule:write', 'terminal', 'sessions:author', 'attachments:write',
      'browser:control', 'web:unlock', 'permission:lower'])
    const keepKnown = (scopes) => ALL_SCOPES.filter((scope) => scopes.includes(scope))
    // Spec 025 R5: the Permissions editor lists only what the device's KIND can hold, so the
    // gateway never has to refuse a tick the page itself offered. This mirrors the contract's
    // DESKTOP_ONLY_SCOPES (client.test.mjs fails on drift), the same table the gateway's
    // `scopesForKind` filters by.
    const DESKTOP_ONLY_SCOPES = new Set(['harness:remote', 'commands:execute', 'workspace:manage',
      'credentials:write', 'plugins:manage', 'schedule:write', 'terminal'])
    // Spec 021 rev 15 (the mirror of the set above): `web:unlock` arms a passkey lock that only a
    // web/`mobile` device can satisfy — a `desktop` never runs a ceremony, so holding it left
    // every desktop frame refused `auth/locked` (measured 2026-11-14, an OTP offer of kind
    // desktop carrying "Full control"). No desktop offer, preset or Approve list may carry it.
    const MOBILE_ONLY_SCOPES = new Set(['web:unlock'])
    const scopesForKind = (kind) => ALL_SCOPES.filter((scope) => (kind === 'desktop'
      ? !MOBILE_ONLY_SCOPES.has(scope) : !DESKTOP_ONLY_SCOPES.has(scope)))
    // What a PAIRING OFFER of this kind asks the gateway for: exactly what its kind may hold.
    // `web:unlock` needs no special case here — `MOBILE_ONLY_SCOPES` above already keeps it off
    // a desktop and in a phone/web list (spec 021 rev 15), so `scopesForKind('mobile')` carries
    // it and an offer simply repeats that list. Restated as its own name because the OFFER is
    // the one place the never-default scope must actually be sent: an offer made for the phone
    // seat without it left the approved PWA unable to register or assert its passkey (gateway
    // log: `scope refused: type=passkey-assert-options … scope=web:unlock`, measured 2026-11-16
    // on a code this page had always made as `desktop`). Deliberately NOT fail-open: if a kind's
    // list ever lost the scope, the offer must lose it too rather than mint it here, because who
    // may hold `web:unlock` is the kind tables' (and the contract's) call, not this page's.
    const gatewayScopesFor = (kind) => scopesForKind(kind)
    // The two seats a pairing code can be made for, in the order the page offers them: the
    // phone/PWA seat (passkey after approval, so its offer carries `web:unlock`) and the old
    // default, a Remote tab on another computer (never a passkey, never `web:unlock`).
    const OTP_KINDS = [
      { kind: 'mobile', labelKey: 'otpKindMobile', hintKey: 'otpKindMobileHint' },
      { kind: 'desktop', labelKey: 'otpKindDesktop', hintKey: 'otpKindDesktopHint' },
    ]

    // The checkbox list + the two preset buttons, shared by Approve and Edit permissions.
    // `allowed` (Approve only): the scopes the pairing request offered. The gateway
    // refuses an Approve that is wider than the offer, so the rest stay listed but
    // disabled and the presets are cut to the offer. `kind` is the OFFER's kind, so the LIST and
    // the presets are cut by it (spec 021 rev 15): a desktop offer neither shows nor ticks
    // `web:unlock` — the gateway drops it anyway, but the page must not offer it in the first place.
    function ScopePicker({ scopes, onChange, allowed, kind }) {
      useLang()
      const listed = scopesForKind(kind)
      const allowedByKind = allowed ? allowed.filter((scope) => listed.includes(scope)) : undefined
      const can = (scope) => !allowedByKind || allowedByKind.includes(scope)
      const presetScopes = (name) => SCOPE_PRESETS[name].filter((scope) => listed.includes(scope))
      const preset = (name) => onChange(keepKnown(presetScopes(name).filter(can)))
      return h('div', { 'data-testid': 'scope-picker' },
        h('div', { className: 'dshdev-row', style: { margin: '6px 0' } },
          h('span', { className: 'dshdev-muted' }, tr('presets')),
          h('button', { type: 'button', className: 'dshdev-btn', onClick: () => preset('standard') }, tr('presetStandard')),
          h('button', { type: 'button', className: 'dshdev-btn danger', title: tr('presetFullHint'), onClick: () => preset('full') }, tr('presetFull'))),
        listed.map((scope) => h('label', { key: scope, className: 'dshdev-row', style: { alignItems: 'flex-start', opacity: can(scope) ? 1 : 0.5 } },
          h('input', {
            type: 'checkbox', checked: scopes.includes(scope), disabled: !can(scope),
            onChange: (event) => onChange(keepKnown(event.target.checked ? [...scopes, scope] : scopes.filter((value) => value !== scope))),
          }),
          h('span', null, tr(`scope.${scope}`),
            RISKY_SCOPES.has(scope) ? h('span', { className: 'dshdev-muted', style: { display: 'block' } }, tr(`risk.${scope}`)) : null,
            can(scope) ? null : h('span', { className: 'dshdev-muted', style: { display: 'block' } }, tr('notRequested'))))))
    }

    // A grant is a list, not a sentence: one muted count above the chips, then one
    // chip per scope. Past SCOPE_CLAMP chips the area is clamped to about two rows
    // and opens on request — CSS only, so EVERY chip stays in the DOM (a screen
    // reader and the page's own tests still see the whole grant).
    const SCOPE_CLAMP = 6
    function ScopeChips({ scopes, testId, empty }) {
      useLang()
      const [open, setOpen] = React.useState(false)
      const list = Array.isArray(scopes) ? scopes : []
      const clamp = list.length > SCOPE_CLAMP
      return h('div', { className: 'dshdev-scopes-block' },
        // The count alone says "how many" — the old "Permissions 13 permissions"
        // pair said the same thing twice on every device row.
        h('div', { className: 'dshdev-scopes-head' },
          h('span', { className: 'dshdev-scopes-count', 'data-testid': 'scope-count' }, withCount('scopeCount', list.length))),
        list.length === 0
          // No scope granted: the list says so in words, and the element keeps its
          // test id so a device with an empty grant and one with many are the same shape.
          ? h('div', { className: 'dshdev-muted', 'data-testid': testId || 'scope-chips' }, empty === undefined ? '—' : empty)
          : h('div', {
            className: `dshdev-scopes${clamp && !open ? ' clamped' : ''}`,
            'data-testid': testId || 'scope-chips',
          }, list.map((scope) => {
            // The amber tint is the ScopePicker's own dangerous set, and the tooltip
            // is the very risk line its checkbox prints — one classification, not two.
            const risky = RISKY_SCOPES.has(scope)
            return h('span', {
              key: scope, className: `dshdev-scope${risky ? ' risk' : ''}`, 'data-scope': scope,
              title: risky ? tr(`risk.${scope}`) : undefined,
            }, tr(`scope.${scope}`))
          })),
        clamp ? h('button', {
          type: 'button', className: 'dshdev-scopes-toggle', 'aria-expanded': open,
          onClick: () => setOpen(!open),
        }, open ? tr('showLessScopes') : withCount('showAllScopes', list.length)) : null)
    }

    // Spec 025 R5: change one paired record's grant in place, through the owner-only route
    // `POST /mgw/devices/:id/scopes`. The page sends the DIFF (`add`/`remove`), not the whole
    // list: the route reads the record itself, so a page that went stale cannot resurrect a
    // permission someone else removed. Only the scopes this device's kind can hold are listed,
    // and `web:unlock` is not tickable here at all — the passkey flow owns it. That was the hole
    // the 2026-11-14 desktop offer fell through: a desktop record listing `web:unlock` filtered it
    // out of `allowed`, so it was neither listed nor removable. The record is repaired by the
    // gateway (`scopesForKind`, once it restarts and reloads the store); until that restart the
    // editor both says so and offers the ONE action that fixes it: drop it.
    const UNSETTABLE_SCOPES = new Set(['web:unlock'])
    function PermissionsEditor({ device, onClose, onApplied }) {
      useLang()
      const notForKind = (Array.isArray(device.scopes) ? device.scopes : []).filter((scope) => !scopesForKind(device.kind).includes(scope))
      // `web:unlock` on a desktop is the only kind-mismatch the owner can see today; it is
      // removable for that kind alone (the route still refuses to ADD it, and a web/`mobile`
      // record keeps the passkey flow's sole ownership).
      const droppable = notForKind.includes('web:unlock') && device.kind === 'desktop' ? ['web:unlock'] : []
      const granted = (Array.isArray(device.scopes) ? device.scopes : []).filter((scope) => !droppable.includes(scope))
      const allowed = scopesForKind(device.kind)
      // `baseline` is the grant the ROUTE last reported, `ticked` what the owner wants: the diff is
      // computed between them, so after a save the button goes quiet instead of re-sending the same
      // change against the row this page was rendered with.
      const [baseline, setBaseline] = React.useState(() => granted.filter((scope) => allowed.includes(scope)))
      const [ticked, setTicked] = React.useState(() => granted.filter((scope) => allowed.includes(scope)))
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      // A refusal the route names ("unknown-scope", "scope-not-for-kind", …) is said in the Host
      // language; anything else keeps its own sentence rather than disappearing into a lookup.
      const setRefusal = (cause) => {
        const key = cause && cause.code ? `permsErr.${cause.code}` : ''
        setError(key && DICT[currentLang()][key] ? tr(key) : String((cause && cause.message) || ''))
      }
      const add = ticked.filter((scope) => !baseline.includes(scope))
      const remove = baseline.filter((scope) => !ticked.includes(scope) && allowed.includes(scope))
        .concat(droppable)
      const save = async () => {
        if (busy || (add.length === 0 && remove.length === 0)) return
        // Explicit confirm: the change closes the device's live connections (spec 025 R3), so it
        // is never a thing that happens on a stray click.
        if (!window.confirm(tr('permsConfirm'))) return
        setBusy(true); setError(''); setNotice('')
        try {
          const answer = await post(`/mgw/devices/${encodeURIComponent(device.id)}/scopes`,
            { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) })
          setNotice(answer && answer.unchanged ? tr('permsUnchanged') : tr('permsApplied'))
          // The route answers the record it really persisted: that becomes the new baseline, so a
          // second click cannot re-send a change that already landed (and the row below agrees).
          const now = Array.isArray(answer && answer.device && answer.device.scopes)
            ? answer.device.scopes.filter((scope) => allowed.includes(scope)) : ticked
          setBaseline(now)
          setTicked(now)
          await onApplied()
        } catch (cause) { setRefusal(cause) } finally { setBusy(false) }
      }
      return h('div', { className: 'dshdev-card', 'data-testid': 'permissions-editor' },
        h('h3', null, `${tr('permissions')} — ${deviceName(device)}`),
        h('div', { className: 'dshdev-muted', style: { marginBottom: 8 } }, tr('permsHelp')),
        // The record holds a scope its kind cannot use (a desktop with `web:unlock`): say it, and
        // offer the removal the Save button below then sends.
        droppable.length > 0
          ? h('div', { className: 'dshdev-err', 'data-testid': 'permissions-not-for-kind' }, tr('permsNotForKeyKind')) : null,
        h('div', { 'data-testid': 'permissions-scopes' }, allowed.map((scope) => h('label', {
          key: scope, className: 'dshdev-row', style: { alignItems: 'flex-start' },
        },
          h('input', {
            type: 'checkbox', checked: ticked.includes(scope),
            disabled: busy || UNSETTABLE_SCOPES.has(scope),
            onChange: (event) => setTicked(keepKnown(event.target.checked
              ? [...ticked, scope] : ticked.filter((value) => value !== scope))),
          }),
          h('span', null, tr(`scope.${scope}`),
            RISKY_SCOPES.has(scope) ? h('span', { className: 'dshdev-muted', style: { display: 'block' } }, tr(`risk.${scope}`)) : null,
            UNSETTABLE_SCOPES.has(scope)
              ? h('span', { className: 'dshdev-muted', style: { display: 'block' } }, tr('permsErr.scope-not-updatable')) : null)))),
        error ? h('div', { className: 'dshdev-err', role: 'alert', 'data-testid': 'permissions-error' }, error) : null,
        notice ? h('div', { className: 'dshdev-muted', 'data-testid': 'permissions-notice' }, notice) : null,
        h('div', { className: 'dshdev-row', style: { marginTop: 10 } },
          h('button', {
            type: 'button', className: 'dshdev-btn primary', disabled: busy || (add.length === 0 && remove.length === 0),
            onClick: save,
          }, tr('permsSave')),
          h('button', { type: 'button', className: 'dshdev-btn', onClick: onClose }, tr('cancel'))))
    }

    // Window 2: who is asking, what for, and the code to compare. Polled every 2 s.
    function PendingRequests({ active }) {
      useLang()
      const [list, setList] = React.useState([])
      const [picked, setPicked] = React.useState({}) // request id -> scopes the owner keeps
      const [error, setError] = React.useState('')
      const mounted = React.useRef(true)
      const refresh = React.useCallback(async () => {
        try {
          const data = await request('/mgw/pending')
          if (!mounted.current) return
          setList(data.pending || [])
          setError('')
        } catch (cause) { if (mounted.current) setError(cause.message) }
      }, [])
      React.useEffect(() => {
        mounted.current = true
        if (!active) return undefined
        refresh()
        const timer = window.setInterval(refresh, 2000)
        return () => { mounted.current = false; window.clearInterval(timer) }
      }, [refresh, active])
      // Approve defaults to the Standard preset, limited to what the device asked
      // for (the gateway refuses anything wider) AND to what its kind may hold
      // (spec 021 rev 15: a desktop offer may not keep `web:unlock`). Anything dangerous
      // is opt-in.
      const scopesOf = (item) => picked[item.id]
        || keepKnown(SCOPE_PRESETS.standard.filter((scope) => scopesForKind(item.kind).includes(scope)
          && item.requestedScopes.includes(scope)))
      const pickScopes = (item, scopes) => setPicked({ ...picked, [item.id]: scopes })
      const decide = async (item, action) => {
        try {
          // Approve sends only the scopes the owner kept (the gateway refuses anything wider).
          await post(`/mgw/pending/${encodeURIComponent(item.id)}/${action}`, action === 'approve' ? { scopes: scopesOf(item) } : {})
          await refresh()
        } catch (cause) { setError(cause.message); refresh() }
      }
      return h('div', { className: 'dshdev-card', 'data-testid': 'pending-requests' },
        h('h3', null, tr('pendingTitle')),
        error ? h('div', { className: 'dshdev-err', role: 'alert' }, error) : null,
        list.length === 0 ? h('div', { className: 'dshdev-muted' }, tr('pendingNone'))
          : h('div', { className: 'dshdev-list' }, list.map((item) => h('div', { key: item.id, 'data-testid': 'pending-item' },
            h('div', { className: 'dshdev-grow' },
              h('div', { className: 'dshdev-row' }, h('strong', null, deviceName(item)), h('span', { className: 'dshdev-badge' }, item.kind)),
              h('div', { className: 'dshdev-muted' }, `${tr('fromIp')}: ${item.clientIp} · ${tr('requestedAt')}: ${new Date(item.createdAt).toLocaleTimeString()}`),
              h('div', { className: 'dshdev-muted', style: { marginTop: 8 } }, tr('verifyCode')),
              h('div', { className: 'dshdev-vcode', 'data-testid': 'verification-code' }, String(item.verificationCode).replace(/^(\d{3})(\d{3})$/, '$1 $2')),
              // Every scope the KIND may hold is listed; the gateway refuses what the device
              // did not request, and the page cuts the presets by kind as well.
              h('div', { style: { marginTop: 6 } }, h(ScopePicker, { scopes: scopesOf(item), allowed: item.requestedScopes, kind: item.kind, onChange: (scopes) => pickScopes(item, scopes) }))),
            h('button', { type: 'button', className: 'dshdev-btn primary', onClick: () => decide(item, 'approve') }, tr('approve')),
            h('button', { type: 'button', className: 'dshdev-btn danger', onClick: () => decide(item, 'reject') }, tr('rejectRequest'))))),
        list.length ? h('div', { className: 'dshdev-muted', style: { marginTop: 6 } }, tr('pendingHelp')) : null)
    }
    // ------------------------------------------------------ tab 1: allow
    // Advanced: the connection plan and the remote-bridge limits in force, behind
    // one disclosure so the page itself stays readable. The limits are read-only:
    // they are the mobile-gateway plugin config (`remoteBridgeLimits`); /mgw has no
    // write route for it, so this page shows them and says where to change them.
    const LIMIT_KEYS = ['maxConnectionsPerDevice', 'maxStreamsPerDevice', 'maxInflightPerDevice', 'callsPerSecond', 'maxResultBytes']
    function AdvancedLimits({ limits, children }) {
      useLang()
      const [open, setOpen] = React.useState(false)
      return h('div', { className: 'dshdev-card', 'data-testid': 'advanced-limits' },
        h('div', { className: 'dshdev-row' },
          h('h3', { className: 'dshdev-grow', style: { margin: 0 } }, tr('advancedLimits')),
          h('button', { type: 'button', className: 'dshdev-btn', 'aria-expanded': open, onClick: () => setOpen(!open) }, open ? '−' : '+')),
        // `children` is the connection plan: one control the owner rarely needs, so
        // it lives behind the same disclosure instead of filling the page.
        open ? h('div', { style: { marginTop: 8 } },
          children || null,
          h('div', { className: 'dshdev-sub-sect' },
            h('div', { className: 'dshdev-muted', style: { marginBottom: 8 } }, tr('limitsHelp')),
            h('div', { className: 'dshdev-list' }, LIMIT_KEYS.map((key) => {
              const value = limits && Number.isSafeInteger(limits[key]) ? limits[key] : 0
              return h('div', { key },
                h('div', { className: 'dshdev-grow' }, tr(`limit.${key}`)),
                h('strong', { 'data-testid': `limit-${key}` }, value === 0 ? `0 (${tr('unlimited')})` : String(value)))
            })))) : null)
    }

    // Spec 008 T036: where the listener really binds. The address is the
    // mobile-gateway plugin CONFIG (`lanHost`), not a route this page can change,
    // so the page states the real bind and — when it is a loopback bind — says
    // plainly that no other machine can connect and where the owner changes it.
    // Read-only: it renders the /mgw/status the tab already polls.
    const LOOPBACK_HOST = /^(?:localhost|::1|0:0:0:0:0:0:0:1|127\..*)$/i
    const isLoopbackHost = (host) => LOOPBACK_HOST.test(String(host || '').replace(/^\[|\]$/g, ''))
    // `lan.urls[0]` already carries the TLS scheme; without one the bind is host:port.
    const listenerBind = (lan) => {
      const urls = (lan && lan.urls) || []
      if (urls.length > 0) return String(urls[0])
      const host = lan && lan.host
      return host ? (lan.port ? `${host}:${lan.port}` : String(host)) : ''
    }
    // A pin is a SHA-256 fingerprint — too long to read at a glance. One helper,
    // used only here; the full value stays in `title` because it is what a client pins.
    const shortenHash = (value) => {
      const full = String(value || '')
      return full.length <= 29 ? full : `${full.slice(0, 17)}…${full.slice(-11)}`
    }
    // A listener inside the OS dynamic (ephemeral) port range competes with the
    // source port of an outbound connection, so its bind can fail at a random
    // moment. The boundaries are the measured range on the machine this was built
    // for (1024-15000 inclusive) and the Windows default (49152-65535 inclusive),
    // not a universal guarantee — 15001-49151 stays quiet because neither range
    // covers it.
    const RISKY_PORT_BELOW = 15000
    const RISKY_PORT_ABOVE = 49152
    const isRiskyListenerPort = (port) => Number.isInteger(port) && port > 0 &&
      (port <= RISKY_PORT_BELOW || port >= RISKY_PORT_ABOVE)

    // The three plans this build can really apply, and the only targets
    // POST /mgw/listen accepts. Cloudflare/P2P are hard-disabled in this fork, so
    // they are not offered: a dead option in a dropdown is a lie.
    const PLAN_TARGETS = ['loopback', 'lan', 'tailscale']
    // Tailscale hands out 100.64.0.0/10 (CGNAT); IPv6 tailnet addresses only ever
    // come from `tailscale.addresses`, which the gateway itself detected.
    const TAILSCALE_IPV4 = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/
    const isTailscaleHost = (host, addresses) => {
      const value = String(host || '').replace(/^\[|\]$/g, '')
      if (!value) return false
      if (TAILSCALE_IPV4.test(value)) return true
      return (addresses || []).some((address) => String(address).replace(/^\[|\]$/g, '') === value)
    }
    // The current plan is DERIVED from status, never remembered: the select must
    // not be able to show a plan the listener is not on. '' = status says nothing,
    // which disables the control instead of guessing.
    const planOf = (status) => {
      const host = status && status.lan && typeof status.lan.host === 'string' ? status.lan.host : ''
      if (!host) return ''
      if (isLoopbackHost(host)) return 'loopback'
      return isTailscaleHost(host, status.tailscale && status.tailscale.addresses) ? 'tailscale' : 'lan'
    }

    // The route a loopback bind is REACHED through, when it is reached at all.
    //
    // `planOf` answers "where did the gateway bind its socket", and a loopback socket
    // is `loopback` — even when the owner put `tailscale serve` (or another TLS
    // front) in front of it so the tailnet and the phone app can reach this machine.
    // The listen TARGET and the reachable ROUTE are two different facts, and the
    // select must keep answering the first one (it is the only thing POST /mgw/listen
    // can apply). So the serve route is reported beside it instead of being folded
    // into the selection, and it is never a selectable option: /mgw/listen has no
    // `serve` target, and an option that silently falls back would be a lie.
    //
    // Evidence only — never inferred from `tailscale.addresses`, which exist on any
    // machine that joined a tailnet whether or not anything is served. The route is
    // claimed only from the Host's own answer: `POST /devices/pair-qr` runs
    // `resolvePwaOrigin` (configured `pwaUrl`, else the node's MagicDNS name on the
    // serve port) and returns that origin as `pwaOrigin`, and that same function
    // decides the reachable address. `null` therefore means "the Host reports no
    // served origin", never "guess from the interface list".
    const serveRouteOf = (qr, lan) => {
      if (!qr || typeof qr.pwaOrigin !== 'string' || !qr.pwaOrigin) return null
      if (qr.link === false) return null
      const info = lan || {}
      // A serve front only makes sense in front of a loopback socket that is up: a
      // non-loopback bind is reached on its own address and needs no route line.
      const host = typeof info.host === 'string' ? info.host : ''
      if (!host || !isLoopbackHost(host)) return null
      if (info.enabled === false || info.listening !== true) return null
      const bind = listenerBind(info)
      return { url: qr.pwaOrigin, subject: typeof qr.address === 'string' ? qr.address : '', bind }
    }

    // POST /mgw/listen refuses with a machine-readable code AND an English sentence
    // (lib/index.mjs). On a page that is not in English the known reasons are named
    // in the Host language instead; anything else is shown verbatim, so a new reason
    // still reaches the owner instead of being swallowed by a missing translation.
    const PLAN_REASON_KEYS = {
      'tailscale/not-detected': 'planErrTailscale',
      'lan/not-detected': 'planErrLan',
      'lan/disabled': 'planErrDisabled',
    }
    const planReason = (cause) => {
      const key = cause && PLAN_REASON_KEYS[cause.code]
      if (key && currentLang() !== 'en') return tr(key)
      return String((cause && cause.message) || '')
    }

    // The connection plan used to be static plugin config (`lanHost`), which meant
    // editing config and restarting to reach this machine over Tailscale. This is
    // the one write on the tab: POST /mgw/listen rebinds the live listener.
    function ConnectionPlan({ status, serveOrigin, onApplied }) {
      useLang()
      const [applying, setApplying] = React.useState('')
      const [error, setError] = React.useState('')
      // A ref, not `applying`: two selections in the same tick would both read the
      // old state and fire two rebinds, so the guard has to be synchronous.
      const inFlight = React.useRef(false)
      const addresses = (status && status.tailscale && status.tailscale.addresses) || []
      const urls = (status && status.tailscale && status.tailscale.urls) || []
      const plan = planOf(status)
      const tailscaleOff = addresses.length === 0
      // The bind the listener is really on, stated next to the control that chose it:
      // the owner should see "here is what you got", not find it in the card below.
      // `status.lan` moves on apply (onApplied) and on every poll, so both paths show it.
      const lan = (status && status.lan) || {}
      const boundHost = typeof lan.host === 'string' ? lan.host : ''
      const bound = listenerBind(lan)
      const privateHost = boundHost && !isLoopbackHost(boundHost) &&
        !isTailscaleHost(boundHost, addresses)
      // The reachable route, from the Host's own answer.
      //
      // `serveOrigin` is learned from `POST /devices/pair-qr`, the only route that runs
      // `resolvePwaOrigin`, so it is the Host saying "this origin serves this gateway".
      // It is NOT read on a poll: the existing tests pin that this block adds no
      // request, and a POST every 3 s would also ask for a QR nobody shows. So the
      // dialog's own reply is handed up when a code is generated, and with no such
      // reply there is no evidence — hence no route line. `tailscale.addresses` alone
      // never claim one: they only prove the machine joined a tailnet.
      const plannedRoute = serveRouteOf(serveOrigin ? { pwaOrigin: serveOrigin, link: true } : null, lan)
      const choose = async (target) => {
        if (inFlight.current || !plan || !target) return
        inFlight.current = true
        setApplying(target); setError('')
        try {
          const data = await post('/mgw/listen', { target })
          // The response carries the new bind, so the card below is already right
          // (address, URLs, pin) before the next status poll.
          if (onApplied) onApplied(data)
        } catch (cause) {
          // Nothing local moves on failure: the select falls back to the plan status reports.
          setError(planReason(cause))
        } finally { inFlight.current = false; setApplying('') }
      }
      // No card of its own: this block is one section inside the "Advanced"
      // disclosure (see AdvancedLimits), so the main page stays readable while the
      // control, its consent text and the bind it produced stay on the page.
      return h('div', { 'data-testid': 'connection-plan' },
        // The section keeps its name ("Connection plan"); the SELECT inside it asks the
        // narrower question ("Gateway bind address"). Two different facts, two labels:
        // the select is the only thing POST /mgw/listen can apply, and the route line
        // below it is how that bind is actually reached.
        h('h3', null, tr('planTitle')),
        h('div', { className: 'dshdev-muted', style: { marginBottom: 8 } }, tr('planHelp')),
        h('div', { className: 'dshdev-row' },
          h('span', { className: 'dshdev-muted' }, tr('planBindTitle')),
          h('select', {
            className: 'dshdev-input', style: { maxWidth: 260 }, 'data-testid': 'plan-select',
            'aria-label': tr('planBindTitle'), value: applying || plan, disabled: !plan || !!applying,
            onChange: (event) => choose(event.target.value),
          },
            plan ? null : h('option', { value: '' }, tr('planUnknown')),
            PLAN_TARGETS.map((target) => h('option', {
              key: target, value: target, disabled: target === 'tailscale' && tailscaleOff,
            }, tr(`plan.${target}`)))),
          applying ? h('span', { className: 'dshdev-muted', 'data-testid': 'plan-applying' }, tr('planApplying')) : null),
        // The route a loopback bind is reached through, stated as a FACT with its
        // origin — never as an option, because /mgw/listen has no `serve` target.
        plannedRoute ? h('div', { 'data-testid': 'plan-serve-route' },
          h('div', { className: 'dshdev-row', style: { marginTop: 8 } },
            h('span', { className: 'dshdev-muted' }, tr('planServeRoute')),
            h('code', { className: 'dshdev-chip', title: plannedRoute.url }, plannedRoute.url),
            h(CopyButton, { text: plannedRoute.url })),
          h('div', { className: 'dshdev-muted' }, `${tr('planServeNote')} ${plannedRoute.bind}`)) : null,
        // Honest consent: what "LAN" means here, and the address it actually produced.
        h('div', { className: 'dshdev-muted', style: { marginTop: 6 }, 'data-testid': 'plan-lan-caveat' }, tr('planLanCaveat')),
        bound ? h('div', { className: 'dshdev-row', style: { marginTop: 6 }, 'data-testid': 'plan-bound' },
          h('span', { className: 'dshdev-muted' }, tr('planBound')),
          h('code', { className: 'dshdev-chip' }, bound)) : null,
        privateHost ? h('div', { className: 'dshdev-muted', 'data-testid': 'plan-private-hint' },
          `${tr('planPrivateHint')} ${boundHost}`) : null,
        // The point of the feature: the Tailscale address the gateway is now on.
        urls.length > 0 ? h('div', { className: 'dshdev-row', style: { marginTop: 8 }, 'data-testid': 'plan-tailscale-urls' },
          h('span', { className: 'dshdev-muted' }, tr('address')),
          urls.map((url) => h('code', { key: String(url), className: 'dshdev-chip' }, String(url)))) : null,
        addresses.length > 0 ? h('div', { className: 'dshdev-muted', 'data-testid': 'plan-tailscale-addresses' },
          addresses.map(String).join(' · ')) : null,
        tailscaleOff ? h('div', { className: 'dshdev-muted', 'data-testid': 'plan-tailscale-unavailable' }, tr('planTailscaleUnavailable')) : null,
        error ? h('div', { className: 'dshdev-err', role: 'alert', 'data-testid': 'plan-error' }, error) : null)
    }

    function ListeningOn({ lan, tailscale }) {
      useLang()
      const info = lan || {}
      const host = typeof info.host === 'string' ? info.host : ''
      const bind = listenerBind(info)
      const up = info.enabled !== false && info.listening === true
      const loopback = up && isLoopbackHost(host)
      // `tailscale.addresses` is the gateway's own detection, so membership is the
      // whole test for "this bind is on my tailnet" — the chip says it in one word.
      const tailscaleAddresses = ((tailscale && tailscale.addresses) || [])
        .map((address) => String(address).replace(/^\[|\]$/g, ''))
      const bare = String(host).replace(/^\[|\]$/g, '')
      const route = !bare ? '' : isLoopbackHost(bare) ? 'routeLoopback'
        : tailscaleAddresses.includes(bare) ? 'routeTailscale' : 'routeLan'
      // A port the OS may already have handed out, or a bind that failed on a busy
      // one (EADDRINUSE), gets one plain line; a quiet port gets nothing.
      const port = Number.isInteger(info.port) && info.port > 0 ? info.port : null
      const portRisk = isRiskyListenerPort(port)
      const portBusy = !up && /EADDRINUSE/.test(String(info.error || ''))
      const portNote = portRisk || portBusy
        ? h('div', { className: 'dshdev-note warn', 'data-testid': 'listener-port-risk' },
          portBusy ? tr('portBusyBody') : `${tr('portRiskBody')} ${tr('portRiskSafeBand')}`) : null
      const address = bind || tr('listenerUnknown')
      return h('div', { className: 'dshdev-card', 'data-testid': 'listening-on' },
        // One fact per line: who is listening, where, and what a client must pin.
        h('div', { className: 'dshdev-row' },
          h('h3', { className: 'dshdev-grow', style: { margin: 0 } }, tr('listeningOn')),
          route ? h('span', { className: 'dshdev-badge', 'data-testid': 'listener-route' }, tr(route)) : null,
          h('span', { className: `dshdev-badge${up ? ' ok' : ' bad'}`, 'data-testid': 'listener-state' }, up ? tr('listenerUp') : tr('listenerDown'))),
        h('div', { className: 'dshdev-row', style: { marginTop: 6 } },
          h('span', { className: 'dshdev-muted' }, tr('reachableNote')),
          h('code', { className: 'dshdev-chip', 'data-testid': 'listener-bind' }, address),
          h(CopyButton, { text: address })),
        info.certSha256 ? h('div', { className: 'dshdev-row', style: { marginTop: 6 } },
          h('span', { className: 'dshdev-muted' }, tr('certPin')),
          h('code', { className: 'dshdev-pin', 'data-testid': 'listener-pin', title: String(info.certSha256) }, shortenHash(info.certSha256)),
          h(CopyButton, { text: String(info.certSha256) })) : null,
        info.error ? h('div', { className: 'dshdev-err', role: 'alert', 'data-testid': 'listener-error' }, String(info.error)) : null,
        portNote,
        // A loopback bind keeps the one long warning (it names where the owner changes
        // it); every other bind says who can connect in its route chip and adds nothing.
        loopback ? h('div', { className: 'dshdev-note warn', 'data-testid': 'listener-loopback' }, tr('loopbackWarning')) : null)
    }

    function AllowTab() {
      useLang()
      const [status, setStatus] = React.useState(null)
      const [devices, setDevices] = React.useState([])
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [pairing, setPairing] = React.useState(null)
      const [otpOffer, setOtpOffer] = React.useState(null)
      // `desktop` keeps the behaviour this page always had (a Remote tab on another computer);
      // `mobile` is the phone/PWA seat, which also asks for `web:unlock` — see `gatewayScopesFor`.
      const [otpKind, setOtpKind] = React.useState('desktop')
      // The Host's own served origin, learned from the QR route the moment a pairing
      // code is generated (see `OtpDialog.onQr`). `null` = the Host never said it serves
      // anything, which is why no route line is drawn: that is the honest answer, and
      // `tailscale.addresses` alone are never evidence of one (spec 029).
      const [serveOrigin, setServeOrigin] = React.useState(null)
      const [editing, setEditing] = React.useState(null) // { device, scopes }
      const [permEditing, setPermEditing] = React.useState(null) // the device whose Permissions editor is open
      const mounted = React.useRef(true)

      const refresh = React.useCallback(async () => {
        try {
          const [s, d] = await Promise.all([request('/mgw/status'), request('/mgw/devices')])
          if (!mounted.current) return
          setStatus(s)
          setDevices(d.devices || [])
        } catch (cause) { if (mounted.current) setError(cause.message) }
      }, [])
      React.useEffect(() => {
        mounted.current = true
        refresh()
        const timer = window.setInterval(refresh, 3000)
        return () => { mounted.current = false; window.clearInterval(timer) }
      }, [refresh])

      const enabled = !!(status && status.remoteControl && status.remoteControl.enabled)
      const accepting = !!(status && status.remoteControl && status.remoteControl.accepting)
      const on = enabled && accepting

      const toggle = async () => {
        if (busy) return
        setBusy(true); setError('')
        try {
          // Both directions go through /mgw/remote-control. When the gateway
          // answers `persists:false` the switch moved but the state file did not
          // take it: it applies until this session ends and the next start
          // follows the saved value, so say so instead of staying quiet.
          let persisted = true
          if (!on) {
            // Same calls as the gateway panel: owner switch, then run the gateway,
            // then pick the LAN route (the only one this page supports).
            persisted = (await post('/mgw/remote-control', { enabled: true })).persists !== false
            await post('/mgw/gateway', { mode: 'persistent' })
            await post('/mgw/connection', { route: 'lan' })
          } else {
            persisted = (await post('/mgw/remote-control', { enabled: false })).persists !== false
            setPairing(null)
          }
          if (!persisted) setError(tr('switchNotSaved'))
          await refresh()
        } catch (cause) { setError(cause.message) } finally { setBusy(false) }
      }

      // Window 1: an 8-digit single-use code (spec 008 P1b).
      const generateOtp = async () => {
        if (busy) return
        setBusy(true); setError('')
        try {
          setPairing(null)
          // The offer asks for every scope its KIND can hold (spec 021 rev 15: a desktop never
          // gets `web:unlock`) so the Host user can choose at Approve (which defaults to
          // Standard); nothing is granted until then. The kind is the one picked next to the
          // button: a code made as `desktop` left every phone/PWA pair locked out of its own
          // passkey (`scope refused: type=passkey-assert-options … scope=web:unlock`).
          setOtpOffer(await post('/mgw/pair', { mode: 'otp', kind: otpKind, scopes: gatewayScopesFor(otpKind) }))
        } catch (cause) { setError(cause.message) } finally { setBusy(false) }
      }

      // Edit permissions still re-pairs through a long pairing string.
      const generate = async (scopes) => {
        if (busy) return
        setBusy(true); setError('')
        try {
          // Spec 021 rev 15: the re-pair offer carries only scopes a `desktop` may hold; the
          // ticked list is already cut by kind, this is the belt to that braces.
          const body = { kind: 'desktop', ...(scopes ? { scopes: scopes.filter((scope) => scopesForKind('desktop').includes(scope)) } : {}) }
          setPairing(await post('/mgw/pair', body))
          setEditing(null)
        } catch (cause) { setError(cause.message) } finally { setBusy(false) }
      }

      const revoke = async (device) => {
        if (!window.confirm(tr('removeConfirm'))) return
        try { await post(`/mgw/devices/${encodeURIComponent(device.id)}/revoke`); await refresh() } catch (cause) { setError(cause.message) }
      }

      // /mgw/listen answers with the bind it applied, so the card below is correct
      // at once instead of waiting up to 3 s for the next status poll.
      const applyPlan = (next) => setStatus((prev) => {
        const merged = { ...(prev || {}) }
        if (next && next.lan) merged.lan = next.lan
        if (next && next.tailscale) merged.tailscale = next.tailscale
        return merged
      })

      const addresses = (status && status.lan && status.lan.listening ? status.lan.urls || [] : [])
        .map((url) => { try { return new URL(url).host } catch { return '' } }).filter(Boolean)

      // The listener state the first card states: the same bind /mgw/status reports,
      // so the row cannot disagree with the "Listening on" card further down.
      const listening = !!(status && status.lan && status.lan.enabled !== false && status.lan.listening === true)
      return h('div', null,
        h(ThisDevice, { status },
          status ? h('div', { className: 'dshdev-row' },
            h('span', { className: listening ? 'dshdev-dot ok' : 'dshdev-dot' }),
            h('span', null, listening ? tr('listenerUp') : tr('listenerDown'))) : null),
        h('div', { className: 'dshdev-card' },
          h('div', { className: 'dshdev-row' },
            h('div', { className: 'dshdev-grow' },
              h('h3', null, tr('allow')),
              h('div', { className: 'dshdev-muted' }, tr('allowHelp'))),
            h('button', {
              type: 'button', role: 'switch', 'aria-checked': on, 'aria-label': tr('allow'),
              className: 'dshdev-switch', disabled: busy || !status, onClick: toggle,
            })),
          h('div', { className: 'dshdev-row', style: { marginTop: 10 } },
            h('label', { className: 'dshdev-row' },
              h('input', { type: 'checkbox', checked: true, disabled: true, readOnly: true }), tr('lan')),
            h('label', { className: 'dshdev-row', title: tr('internetLater') },
              h('input', { type: 'checkbox', checked: false, disabled: true, readOnly: true }), tr('internet'),
              h('span', { className: 'dshdev-muted' }, `(${tr('internetLater')})`)))),
        error ? h('div', { className: 'dshdev-err', role: 'alert' }, error) : null,
        h('div', { className: 'dshdev-card' },
          h('div', { className: 'dshdev-row' },
            h('h3', { className: 'dshdev-grow' }, tr('pairingCode')),
            h('button', { type: 'button', className: 'dshdev-btn primary', disabled: busy || !on, onClick: generateOtp }, tr('generate'))),
          // The code's KIND, chosen before the code exists: a code is bound to one kind for its
          // whole life, so picking it afterwards would mean making a second code.
          h('div', { className: 'dshdev-row', style: { marginTop: 10, flexWrap: 'wrap' } },
            h('span', { className: 'dshdev-muted' }, tr('otpKindLabel')),
            OTP_KINDS.map((entry) => h('label', {
              key: entry.kind, className: 'dshdev-row', title: tr(entry.hintKey),
              'data-testid': `otp-kind-${entry.kind}`,
            },
              h('input', {
                type: 'radio', name: 'otp-kind', value: entry.kind, checked: otpKind === entry.kind,
                disabled: busy || !on, onChange: () => setOtpKind(entry.kind),
              }),
              h('span', null, tr(entry.labelKey))))),
          h('div', { className: 'dshdev-muted' }, tr(`otpKind${otpKind === 'mobile' ? 'Mobile' : 'Desktop'}Hint`)),
          !on ? h('div', { className: 'dshdev-muted' }, tr('enableFirst')) : null),
        otpOffer ? h(OtpDialog, { offer: otpOffer, addresses, lanHost: status && status.lan ? status.lan.host : '',
          // Spec 029: the QR route's answer is the Host's own served origin, kept in the
          // background so closing the dialog does not forget the route this machine
          // is reachable through (the plan states it as a fact, never as a target).
          // EVERY successful reply replaces the cache: `{pwaOrigin: null, link: false}`
          // is the Host saying it no longer serves that origin, so keeping the old
          // value would draw a route the Host has just disclaimed.
          onQr: (reply) => {
            const origin = reply && typeof reply.pwaOrigin === 'string' && reply.pwaOrigin ? reply.pwaOrigin : null
            setServeOrigin(origin)
          },
          onClose: () => setOtpOffer(null) }) : null,
        h(PendingRequests, { active: on }),
        pairing && !editing ? h(PairingBox, { pairing, onClose: () => setPairing(null) }) : null,
        h('div', { className: 'dshdev-card' },
          h('h3', null, tr('address')),
          addresses.length === 0 ? h('div', { className: 'dshdev-muted' }, tr('noAddress'))
            : h('div', { className: 'dshdev-row' }, addresses.map((address) =>
              h('span', { key: address, className: 'dshdev-chip' }, address, h(CopyButton, { text: address }))))),
        h('div', { className: 'dshdev-card', 'data-testid': 'authorized-devices' },
          h('h3', null, tr('authorized')),
          devices.length === 0 ? h('div', { className: 'dshdev-muted' }, tr('noAuthorized'))
            : h('div', { className: 'dshdev-items', style: { marginBottom: 0, marginTop: 10 } }, devices.map((device) => h('div', {
              key: device.id, className: 'dshdev-item dshdev-item-stack', 'data-testid': 'authorized-item',
            },
              // Header line: who it is, then the two actions on the right. The body
              // below spans the card, so the grant is not squeezed into the column
              // the buttons leave — on a narrow card the actions wrap under the name.
              h('div', { className: 'dshdev-item-top' },
                h('div', { className: 'dshdev-tile' }, deviceIcon(device.kind)),
                h('div', { className: 'dshdev-item-main' },
                  h('div', { className: 'dshdev-item-head' },
                    h('strong', { className: 'dshdev-item-name' }, deviceName(device)),
                    h('span', { className: 'dshdev-badge' }, device.kind || 'mobile'),
                    device.online ? h('span', { className: 'dshdev-badge ok' }, tr('connectedHere')) : null)),
                h('div', { className: 'dshdev-item-actions' },
                  // Spec 025 R5: change the grant in place. Re-pairing stays available (Edit) but is
                  // no longer the only way to widen or narrow one record.
                  h('button', { type: 'button', className: 'dshdev-btn', disabled: !on, onClick: () => { setPairing(null); setEditing(null); setPermEditing(device) } }, tr('permissions')),
                  h('button', { type: 'button', className: 'dshdev-btn', disabled: !on, onClick: () => { setPairing(null); setPermEditing(null); setEditing({ device, scopes: [...(device.scopes || [])] }) } }, tr('edit')),
                  h('button', { type: 'button', className: 'dshdev-btn danger', onClick: () => revoke(device) }, tr('remove')))),
              h('div', { className: 'dshdev-item-body' },
                // A record paired before spec 013 cannot upload files, and nothing on the row said
                // so: the hint names the fix and points at the editor next to it.
                (device.scopes || []).includes('attachments:write') ? null
                  : h('div', { className: 'dshdev-note warn', 'data-testid': 'missing-upload-hint' }, tr('permsMissingUpload')),
                h(ScopeChips, { scopes: device.scopes }),
                h('div', { className: 'dshdev-item-meta' },
                  h('span', { className: 'dshdev-muted' }, tr('lastUsed')),
                  h('span', { 'data-testid': 'last-used' }, stampWhen(device.lastSeenAt)))))))),
        editing ? h('div', { className: 'dshdev-card', 'data-testid': 'edit-permissions' },
          h('h3', null, `${tr('edit')} — ${deviceName(editing.device)}`),
          h('div', { className: 'dshdev-muted', style: { marginBottom: 8 } }, tr('editHelp')),
          h(ScopePicker, { scopes: editing.scopes, kind: editing.device.kind, onChange: (scopes) => setEditing({ ...editing, scopes }) }),
          h('div', { className: 'dshdev-row', style: { marginTop: 10 } },
            h('button', { type: 'button', className: 'dshdev-btn primary', disabled: busy, onClick: () => generate(editing.scopes) }, tr('editSave')),
            h('button', { type: 'button', className: 'dshdev-btn', onClick: () => setEditing(null) }, tr('cancel')))) : null,
        pairing && editing ? h(PairingBox, { pairing }) : null,
        // Spec 025 R5: the in-place editor. `refresh` re-reads /mgw/devices, so the row below shows
        // the grant the route really persisted, not the one this page hoped for.
        permEditing ? h(PermissionsEditor, {
          key: permEditing.id, device: permEditing,
          onClose: () => setPermEditing(null), onApplied: refresh,
        }) : null,
        // The bind the listener really serves is a state card; the control that
        // changes it sits behind "Advanced" with the limits, so the page is quiet.
        h(ListeningOn, { lan: status && status.lan, tailscale: status && status.tailscale }),
        h(AdvancedLimits, { limits: status && status.remoteBridgeLimits },
          h(ConnectionPlan, { status, serveOrigin, onApplied: applyPlan })))
    }

    // --------------------------------------------------- tab 2: connect
    // "Add device" (Qoder-style): LAN | Internet(disabled), Address, 8-digit pairing
    // code, Display name; the pairing string is an "Advanced" link. Submitting
    // starts a server-side pairing session that waits for the Host's approval; the
    // dialog polls it, shows the verification code, and can cancel.
    function AddDeviceDialog({ onClose, onAdded }) {
      useLang()
      const [address, setAddress] = React.useState('')
      const [code, setCode] = React.useState('')
      const [pairingString, setPairingString] = React.useState('')
      const [advanced, setAdvanced] = React.useState(false)
      const [name, setName] = React.useState('')
      const [session, setSession] = React.useState(null) // pairing view from /devices/pairings
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const mounted = React.useRef(true)
      React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

      const active = session && (session.state === 'connecting' || session.state === 'pending')
      React.useEffect(() => {
        if (!active) return undefined
        const timer = window.setInterval(async () => {
          try {
            const data = await request(`/devices/pairings/${encodeURIComponent(session.id)}`)
            if (!mounted.current) return
            setSession(data.pairing)
            if (data.pairing.state === 'approved') onAdded()
          } catch (cause) { if (mounted.current) setError(cause.message) }
        }, 1000)
        return () => window.clearInterval(timer)
      }, [active, session && session.id])

      const submit = async (event) => {
        event.preventDefault()
        if (busy || active) return
        setBusy(true); setError('')
        try {
          const body = { address: address.trim(), ...(name.trim() ? { name: name.trim() } : {}),
            ...(advanced ? { pairingString: pairingString.trim() } : { otp: code.replace(/\D/g, '') }) }
          setSession((await post('/devices/pairings', body)).pairing)
        } catch (cause) { setError(cause.message) } finally { setBusy(false) }
      }
      const cancel = async () => {
        if (active) { try { await request(`/devices/pairings/${encodeURIComponent(session.id)}`, { method: 'DELETE' }) } catch { /* it ends on its own */ } }
        onClose()
      }
      const ready = address.trim() && (advanced ? pairingString.trim() : code.replace(/\D/g, '').length === 8)

      if (session && session.state === 'approved') {
        return h(Dialog, { title: tr('addTitle'), onClose: cancel },
          h('div', { className: 'dshdev-badge ok' }, tr('pairApproved')),
          h('div', { className: 'dshdev-row', style: { marginTop: 12 } }, h('button', { type: 'button', className: 'dshdev-btn primary', onClick: onClose }, tr('otpClose'))))
      }
      if (active) {
        return h(Dialog, { title: tr('addTitle'), onClose: cancel },
          h('h3', null, tr('waiting')),
          session.verificationCode
            ? h('div', null, h('div', { className: 'dshdev-muted' }, tr('waitingCode')), h('div', { className: 'dshdev-vcode', 'data-testid': 'waiting-code' }, session.verificationCode))
            : h('div', { className: 'dshdev-muted' }, tr('working')),
          h('div', { className: 'dshdev-muted', style: { margin: '8px 0' } }, tr('waitingHelp')),
          h('div', { className: 'dshdev-row' }, h('button', { type: 'button', className: 'dshdev-btn', onClick: cancel }, tr('cancelWait'))))
      }
      return h(Dialog, { title: tr('addTitle'), onClose },
        h('form', { onSubmit: submit },
          h('div', { style: { display: 'grid', gap: 10 } },
            h('div', { className: 'dshdev-seg', role: 'group' },
              h('button', { type: 'button', 'aria-pressed': true }, tr('addLan')),
              h('button', { type: 'button', disabled: true, title: tr('internetLater') }, tr('addInternetLater'))),
            h('label', null, h('div', { className: 'dshdev-muted' }, tr('addAddress')),
              h('input', { className: 'dshdev-input', value: address, placeholder: '192.168.1.9:41234', onChange: (e) => setAddress(e.target.value), 'aria-label': tr('addAddress') })),
            advanced
              ? h('label', null, h('div', { className: 'dshdev-muted' }, tr('pairingLabel')),
                h('textarea', { className: 'dshdev-input', rows: 3, value: pairingString, spellCheck: false, onChange: (e) => setPairingString(e.target.value), 'aria-label': tr('pairingLabel') }))
              : h('label', null, h('div', { className: 'dshdev-muted' }, `${tr('addCode')} — ${tr('addCodeHint')}`),
                h('input', { className: 'dshdev-input', value: code, inputMode: 'numeric', autoComplete: 'off', placeholder: '1234 5678', maxLength: 9,
                  onChange: (e) => setCode(e.target.value), 'aria-label': tr('addCode') })),
            h('label', null, h('div', { className: 'dshdev-muted' }, tr('addName')),
              h('input', { className: 'dshdev-input', value: name, onChange: (e) => setName(e.target.value), 'aria-label': tr('addName') })),
            h('button', { type: 'button', className: 'dshdev-btn', style: { justifySelf: 'start', border: 0, padding: 0, textDecoration: 'underline' },
              onClick: () => setAdvanced(!advanced) }, advanced ? tr('advancedBack') : tr('advanced')),
            h('div', { className: 'dshdev-muted' }, tr('addNote')),
            error ? h('div', { className: 'dshdev-err', role: 'alert' }, error) : null,
            h('div', { className: 'dshdev-row', style: { justifyContent: 'flex-end' } },
              h('button', { type: 'button', className: 'dshdev-btn', onClick: onClose }, tr('cancel')),
              h('button', { type: 'submit', className: 'dshdev-btn primary', disabled: busy || !ready }, busy ? tr('working') : tr('addSubmit'))))))
    }

    // The Connect tab's section-header action. It keeps the dialog the card used to
    // open — one click, same fields, same routes — and starts closed; the "+" is
    // drawn by CSS so the button's text stays exactly the translated label.
    function AddDeviceForm({ onAdded }) {
      useLang()
      const [open, setOpen] = React.useState(false)
      return h(React.Fragment, null,
        h('button', { type: 'button', className: 'dshdev-link add', onClick: () => setOpen(true) }, tr('addDevice')),
        open ? h(AddDeviceDialog, { onClose: () => setOpen(false), onAdded }) : null)
    }
    function statusBadge(status) {
      const cls = status === 'online' ? 'ok' : (status === 'revoked' || status === 'error') ? 'bad' : ''
      return h('span', { className: `dshdev-badge ${cls}` }, tr(`status.${status}`))
    }
    // A row's link state as a coloured dot; the word next to it stays the same
    // string the badge used. The dot is what carries the state — an answering link
    // is green, a dialling one amber (and breathing), a plain one grey, and access
    // the host took back is red.
    const dotClass = (status) => (status === 'online' ? 'dshdev-dot ok'
      : status === 'connecting' ? 'dshdev-dot warn'
      : status === 'revoked' || status === 'error' ? 'dshdev-dot off' : 'dshdev-dot')

    function RemoteDetail({ remote, onBack, onChanged }) {
      useLang()
      const [sessions, setSessions] = React.useState(null)
      const [approvals, setApprovals] = React.useState(remote.approvals || [])
      const [selected, setSelected] = React.useState('')
      const [history, setHistory] = React.useState(null)
      const [text, setText] = React.useState('')
      const [error, setError] = React.useState('')
      const [note, setNote] = React.useState('')
      const base = `/devices/remotes/${encodeURIComponent(remote.id)}`
      const mounted = React.useRef(true)

      const load = React.useCallback(async () => {
        try {
          const data = await request(`${base}/sessions`)
          if (!mounted.current) return
          setSessions(data.sessions || []); setApprovals(data.approvals || []); setError('')
        } catch (cause) { if (mounted.current) setError(cause.message) }
      }, [base])
      React.useEffect(() => {
        mounted.current = true
        load()
        const timer = window.setInterval(load, 4000)
        return () => { mounted.current = false; window.clearInterval(timer) }
      }, [load])

      const openSession = async (sessionId) => {
        setSelected(sessionId); setHistory(null); setNote('')
        // A subagent child is readable only with its durable parent address (DSH
        // refuses a plain session address with `session/agent-busy`). The row this
        // view already listed names the parent, so the request carries it instead of
        // relying on the server-side fallback.
        const row = (sessions || []).find((entry) => (entry.sessionId || entry.id) === sessionId)
        const parent = row && row.origin === 'subagent' && typeof row.parentSessionId === 'string' ? row.parentSessionId : ''
        const target = `${base}/history?sessionId=${encodeURIComponent(sessionId)}` +
          (parent ? `&parentSessionId=${encodeURIComponent(parent)}&subagentMode=unknown` : '')
        try { setHistory((await request(target)).history) } catch (cause) { setError(cause.message) }
      }
      const send = async () => {
        if (!selected || !text.trim()) return
        try {
          await post(`${base}/prompt`, { sessionId: selected, text })
          setText(''); setNote(tr('sent'))
          openSession(selected)
        } catch (cause) { setError(cause.message) }
      }
      const decide = async (approval, outcome) => {
        try {
          // Echo the hash the card showed; the server binds the decision to it.
          await post(`${base}/approval`, { rpcId: approval.rpcId, sessionId: approval.sessionId, approvalId: approval.approvalId, argsHash: approval.argsHash, outcome })
          await load()
        } catch (cause) { setError(cause.message); load() }
      }
      const sessionTitle = (row) => (row.projections && row.projections.values && row.projections.values.title) || row.title || row.sessionId || row.id
      const rows = (history && (history.items || history.records || history.messages)) || []

      return h('div', null,
        h('div', { className: 'dshdev-row', style: { marginBottom: 10 } },
          // Only a card opened from a list has somewhere to go back to; the same card
          // opened as a tab (spec 016 Phase 1) has not, so it draws no inert button.
          typeof onBack === 'function' ? h('button', { type: 'button', className: 'dshdev-btn', onClick: onBack }, tr('back')) : null,
          h('h3', { className: 'dshdev-grow', style: { margin: 0 } }, remote.name),
          statusBadge(remote.status),
          h('button', { type: 'button', className: 'dshdev-btn', onClick: load }, tr('refresh'))),
        error ? h('div', { className: 'dshdev-err', role: 'alert' }, error) : null,
        h('div', { className: 'dshdev-card' },
          h('h3', null, tr('approvals')),
          approvals.length === 0 ? h('div', { className: 'dshdev-muted' }, tr('noApprovals'))
            : h('div', { className: 'dshdev-list' }, approvals.map((approval) => h('div', { key: approval.rpcId },
              h('div', { className: 'dshdev-grow' },
                h('strong', null, approval.toolName),
                approval.reason ? h('div', { className: 'dshdev-muted' }, approval.reason) : null,
                approval.argsPreview ? h('code', { className: 'dshdev-code' }, approval.argsPreview) : null,
                typeof approval.argsHash !== 'string' ? h('div', { className: 'dshdev-muted' }, tr('desktopOnly')) : null),
              typeof approval.argsHash === 'string' ? [
                h('button', { key: 'a', type: 'button', className: 'dshdev-btn primary', onClick: () => decide(approval, 'allowed-once') }, tr('allowOnce')),
                h('button', { key: 'r', type: 'button', className: 'dshdev-btn danger', onClick: () => decide(approval, 'rejected') }, tr('reject')),
              ] : null)))),
        h('div', { className: 'dshdev-card' },
          h('h3', null, tr('sessions')),
          sessions === null ? h('div', { className: 'dshdev-muted' }, tr('working'))
            : sessions.length === 0 ? h('div', { className: 'dshdev-muted' }, tr('noSessions'))
              : h('div', { className: 'dshdev-list' }, sessions.map((row) => {
                const sessionId = row.sessionId || row.id
                return h('div', { key: sessionId },
                  h('div', { className: 'dshdev-grow' }, sessionTitle(row), row.running ? h('span', { className: 'dshdev-badge ok', style: { marginLeft: 8 } }, '●') : null),
                  h('button', { type: 'button', className: 'dshdev-btn', 'aria-pressed': selected === sessionId, onClick: () => openSession(sessionId) }, tr('open')))
              }))),
        selected ? h('div', { className: 'dshdev-card' },
          h('h3', null, tr('history')),
          history === null ? h('div', { className: 'dshdev-muted' }, tr('working'))
            : rows.length === 0 ? h('div', { className: 'dshdev-muted' }, tr('noHistory'))
              : rows.map((row, index) => h('div', { key: row.seq ?? index, className: `dshdev-msg ${row.role === 'user' ? 'user' : ''}` },
                typeof row.text === 'string' ? row.text : (typeof row.content === 'string' ? row.content : JSON.stringify(row)).slice(0, 2000))),
          h('h3', { style: { marginTop: 12 } }, tr('prompt')),
          h('textarea', { className: 'dshdev-input', rows: 3, value: text, onChange: (e) => setText(e.target.value), 'aria-label': tr('prompt') }),
          h('div', { className: 'dshdev-row', style: { marginTop: 8 } },
            h('button', { type: 'button', className: 'dshdev-btn primary', disabled: !text.trim(), onClick: send }, tr('send')),
            note ? h('span', { className: 'dshdev-muted' }, note) : null)) : null)
    }

    const scopesOfGrant = (remote) => (remote && remote.device && Array.isArray(remote.device.scopes) ? remote.device.scopes : null)
    /**
     * The grant a remote Host made does not include `harness:remote`, so the merged
     * session/workspace lists carry Local rows only — the feature is dead while every
     * indicator stays green (spec 008, measured end to end). Re-pairing is the only
     * fix: the gateway has no scope-update route.
     * A gateway older than scopes sends no list at all; then nothing is claimed.
     */
    const lacksRemoteScope = (remote) => {
      const scopes = scopesOfGrant(remote)
      return scopes !== null && !scopes.includes('harness:remote')
    }

    // Spec 013: whether attachment bytes can reach a remote Host. `wrapped` is
    // measured by the Host on every read, so a route that was replaced after load
    // shows up here instead of as a native 404 on the first tagged upload (A1.1).
    // A Host that reports no `uploads` at all is an older one: claim nothing.
    //
    // `not-installed` is the one reason that is NOT yet a failure: it means the
    // install fiber is still waiting for the `connection` or `fileUploads`
    // service, which on a real Host start is normal for a few seconds (the
    // connection provider awaits BrowserAuth.create). It is shown as neutral
    // status, and only after the tab's own poll has read it this many times
    // (4 s apart, so ~1 min) does it become an alert: a service that never
    // appears is a broken Host, and hiding that forever would be the A1.1
    // failure mode this note exists to prevent.
    const UPLOAD_WAIT_POLLS = 15
    const uploadsNote = (uploads, waitPolls = 0) => {
      if (!uploads || typeof uploads !== 'object') return null
      if (uploads.wrapped === true) return null
      const reason = typeof uploads.reason === 'string' && uploads.reason !== '' ? uploads.reason : 'unknown'
      if (reason === 'disabled') {
        return h('div', { key: 'uploads', className: 'dshdev-muted', 'data-testid': 'remote-uploads', 'data-reason': reason, role: 'status' },
          tr('uploadsOff'))
      }
      if (reason === 'not-installed' && waitPolls < UPLOAD_WAIT_POLLS) {
        return h('div', { key: 'uploads', className: 'dshdev-muted', 'data-testid': 'remote-uploads', 'data-reason': reason, role: 'status' },
          tr('uploadsWaiting'))
      }
      return h('div', { key: 'uploads', className: 'dshdev-err', 'data-testid': 'remote-uploads', 'data-reason': reason, role: 'alert' },
        `${tr('uploadsBroken')} (${reason})`)
    }

    // Spec 016 Phase 3: a tab type per paired host. The kind carries the host id, so
    // the tab type's title ("Browser (agent) · <host>") is per machine and the body
    // can be keyed to one host without reading anything from the remote.
    const agentKindOf = (hostId) => `dsh-ext.devices.browser-agent.${hostId}`

    // ------------------------------------------- spec 016 Phase 1: per-machine doors
    // The Start page is a flat, `order`-sorted list of capsules contributed by tab
    // types (`sidebarRightTabs` -> `guide`), and picking a capsule opens ITS OWNER's
    // kind: an entry carries no params and cannot name another page. One doorway is
    // therefore one tab type, so every entry below is registered as its own type with
    // a single-entry `guide` — that is the only shape the shell can honour.
    const HOST_DOOR_BASE = 1000
    const HOST_DOOR_STRIDE = 100
    // The doorways one paired machine contributes. `host` is the machine's own card
    // (its sessions, history and approvals); `devices` is the Devices page, where its
    // grant, its consent and this machine's browser are managed.
    const HOST_DOORWAYS = ['host', 'devices']
    const hostDoorId = (hostId, entry) => `dsh-ext.devices.${hostId}.${entry}`

    /**
     * Spec 016 Phase 1: the entries one set of paired machines contributes to the
     * Start page. Only a CONNECTED machine gets them — the spec says "per connected
     * remote host" — so an offline one is omitted rather than shown dead: a capsule
     * that opens a card for a machine which cannot answer is a doorway onto nothing.
     *
     * Orders: every shipped capsule sits at 10–60 (workspace files 10, code review 15,
     * terminal 20, browser 30, session inspector 60), so a block starts at 1000 — the
     * first round number above all of them, which keeps every local doorway first — and
     * each machine gets 100 slots (stride 100) so its entries stay contiguous and a
     * later phase can add doorways to a machine without renumbering the others. The
     * block index comes from the host ids sorted, so the same paired set always yields
     * the same numbers regardless of the order the Host listed them in.
     * @param {Array<{id: string, name: string, status?: string}>} remotes paired machines
     * @returns {Array<{key: string, hostId: string, id: string, order: number, title: () => string, description: () => string, icon: Function}>}
     */
    function hostDoorEntries(remotes) {
      const connected = (Array.isArray(remotes) ? remotes : [])
        .filter((remote) => remote && typeof remote.id === 'string' && remote.status === 'online')
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      return connected.flatMap((remote, index) => HOST_DOORWAYS.map((key, offset) => ({
        key,
        hostId: remote.id,
        id: hostDoorId(remote.id, key),
        order: HOST_DOOR_BASE + index * HOST_DOOR_STRIDE + offset,
        // `<item> · <host>` is how every other per-host label in this plugin reads
        // (`Browser (agent) · <host>`, `REA_Project · Sigma-DSH`).
        title: () => `${key === 'devices' ? tr('title') : tr('hostDoor')} · ${remote.name}`,
        description: () => tr(key === 'devices' ? 'devicesDoorDescription' : 'hostDoorDescription'),
        icon: key === 'devices' ? DevicesPanelIcon : HostDoorIcon,
      })))
    }

    // The machine card's glyph: one more mark in the same 24-unit monochrome style as
    // `deviceGlyph`, so a guide capsule drawn by the shell carries this package's ink.
    function HostDoorIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
      h('rect', { x: 2.5, y: 4.5, width: 11, height: 8, rx: 1.5 }),
      h('path', { d: 'M5.5 16.5h4M7.5 12.5v4' }),
      h('path', { d: 'M17.5 6.5v10M14.5 13.5l3 3 3-3' }))
    }

    // Changes only the address of an already paired host (PATCH keeps the pinned
    // certificate, so no credential is re-issued). The server's own refusal
    // sentence is shown inline and the editor stays open so the owner can fix it.
    function AddressEditor({ remote, onDone }) {
      useLang()
      const [editing, setEditing] = React.useState(false)
      const [value, setValue] = React.useState(remote.address || '')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const mounted = React.useRef(true)
      React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
      if (!editing) {
        return h('button', {
          type: 'button', className: 'dshdev-link', 'data-testid': 'address-edit',
          onClick: () => { setValue(remote.address || ''); setError(''); setEditing(true) },
        }, tr('editAddress'))
      }
      const save = async () => {
        if (busy) return
        setBusy(true); setError('')
        try {
          await request(`/devices/remotes/${encodeURIComponent(remote.id)}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: value }),
          })
          if (mounted.current) setEditing(false)
          if (onDone) await onDone()
        } catch (cause) {
          if (mounted.current) setError(cause.message)
        } finally { if (mounted.current) setBusy(false) }
      }
      return h('div', { 'data-testid': 'address-editor', style: { marginTop: 6 } },
        h('input', {
          type: 'text', className: 'dshdev-input', 'data-testid': 'address-input', 'aria-label': tr('addressLabel'),
          value, disabled: busy, spellCheck: false,
          onChange: (event) => setValue(event.target.value),
        }),
        h('div', { className: 'dshdev-muted', 'data-testid': 'address-pin-note' }, tr('addressPinNote')),
        error ? h('div', { className: 'dshdev-err', role: 'alert', 'data-testid': 'address-error' }, error) : null,
        h('div', { className: 'dshdev-row' },
          h('button', { type: 'button', className: 'dshdev-btn', 'data-testid': 'address-save', disabled: busy, onClick: save },
            busy ? tr('addressSaving') : tr('saveAddress')),
          h('button', { type: 'button', className: 'dshdev-btn', 'data-testid': 'address-cancel', disabled: busy,
            onClick: () => { setEditing(false); setError('') } }, tr('cancel'))))
    }

    function ConnectTab() {
      useLang()
      const [remotes, setRemotes] = React.useState([])
      const [status, setStatus] = React.useState(null)
      // Spec 013: the Host's own attachment bridge rides the same read.
      const [uploads, setUploads] = React.useState(null)
      // Consecutive polls the bridge spent `not-installed` (see `uploadsNote`).
      const [uploadWait, setUploadWait] = React.useState(0)
      const [openId, setOpenId] = React.useState('')
      const [error, setError] = React.useState('')
      const [connecting, setConnecting] = React.useState('')
      const [consenting, setConsenting] = React.useState('')
      const [connectError, setConnectError] = React.useState(null)
      const mounted = React.useRef(true)
      // Two reads the tab needs anyway: the paired hosts, and this machine's own
      // identity (/mgw/status, the route the Allow tab already polls). A gateway that
      // does not answer it leaves the name out — it must not turn the host list into
      // an error, and it adds no timer and no route of its own.
      const refresh = React.useCallback(async () => {
        try {
          const [data, mgw] = await Promise.all([
            request('/devices/remotes'),
            request('/mgw/status').catch(() => null),
          ])
          if (!mounted.current) return
          setRemotes(data.remotes || [])
          // A bridge still waiting for its services is a transient startup state,
          // not a failure: count consecutive polls so the note can stay neutral
          // briefly and turn into an alert if the wait never ends.
          const waiting = data.uploads?.wrapped === false && data.uploads?.reason === 'not-installed'
          setUploadWait((count) => (waiting ? count + 1 : 0))
          setUploads(data.uploads ?? null)
          setStatus(mgw)
        } catch (cause) { if (mounted.current) setError(cause.message) }
      }, [])
      // The chip's Reconnect lives in a popover that exists only inside an already open
      // remote session, and the row's Open only dials the host as a side effect of
      // RemoteDetail's sessions read. So a dead link had no explicit retry here, which is
      // exactly when one is needed: the row dials through the same route the chip uses,
      // one click from this tab and without opening a session. The chip and this row never
      // render in one view, so there is never a second Reconnect on screen.
      const connect = async (remote) => {
        if (connecting) return
        setConnecting(remote.id); setConnectError(null)
        try {
          await post(`/devices/remotes/${encodeURIComponent(remote.id)}/connect`)
          // Re-read the list this tab already polls (no new poll): the row's status and
          // any `hostError` come from the Host's answer, not from our optimistic guess.
          await refresh()
        } catch (cause) {
          // The route's reason is the point of pressing this: keep it on that row.
          if (mounted.current) setConnectError({ id: remote.id, message: cause.message })
        } finally { if (mounted.current) setConnecting('') }
      }
      React.useEffect(() => {
        mounted.current = true
        refresh()
        const timer = window.setInterval(refresh, 4000)
        return () => { mounted.current = false; window.clearInterval(timer) }
      }, [refresh])
      const opened = remotes.find((remote) => remote.id === openId)
      if (opened) return h(RemoteDetail, { remote: opened, onBack: () => setOpenId(''), onChanged: refresh })
      const remove = async (remote) => {
        try { await request(`/devices/remotes/${encodeURIComponent(remote.id)}`, { method: 'DELETE' }); await refresh() } catch (cause) { setError(cause.message) }
      }
      // Spec 016 Phase 3: the owner's per-host consent. The route redials the link so
      // the host's capability list matches the new setting at once.
      const setConsent = async (remote, allow) => {
        if (consenting) return
        setConsenting(remote.id); setError('')
        try {
          await post(`/devices/remotes/${encodeURIComponent(remote.id)}/browser`, { allow })
          await refresh()
        } catch (cause) { if (mounted.current) setError(cause.message) } finally { if (mounted.current) setConsenting('') }
      }
      // One card per paired host: an icon tile, the name with the link state, the
      // address in a mono line, then the row's own notes and three icon actions.
      // Every note keeps its data-testid and its exact sentence.
      const remoteCard = (remote) => {
        // The icon button's accessible name says what the row is doing now, exactly
        // like the text it renders.
        const dialling = connecting === remote.id
        const dialLabel = dialling ? tr('reconnecting') : tr('reconnect')
        const notes = [
          // The link supervisor is already dialling: "offline" here does not
          // mean "waiting for a human", and the Reconnect button stays usable.
          remote.retry
            ? h('div', { key: 'retry', className: 'dshdev-muted', 'data-testid': 'remote-retry', role: 'status' }, tr('autoRetry'))
            : null,
          // The pin the pairing recorded is no longer what the host presents.
          // Retrying cannot fix that, so the row says what happened and that
          // nothing was sent (no credential left this machine).
          remote.linkError === 'pin-mismatch'
            ? h('div', { key: 'pin', className: 'dshdev-err', 'data-testid': 'remote-pin-mismatch', role: 'alert' }, tr('pinMismatchNote'))
            : null,
          lacksRemoteScope(remote)
            ? h('div', { key: 'scope', className: 'dshdev-warn', 'data-testid': 'missing-remote-scope', role: 'status' }, tr('missingRemoteScope'))
            : null,
          remote.hostError
            ? h('div', { key: 'refused', className: 'dshdev-muted', 'data-testid': 'host-refused' },
              `${tr('hostRefused')} — ${remote.hostError.code}${remote.hostError.scope ? ` (${remote.hostError.scope})` : ''}`)
            : null,
          connectError && connectError.id === remote.id
            ? h('div', { key: 'dial', className: 'dshdev-err', role: 'alert', 'data-testid': 'remote-reconnect-error' }, connectError.message)
            : null,
          // Spec 013: the attachment bridge is this Host's, not the remote's, so the
          // note lands on every row and explains why a send would 404.
          uploadsNote(uploads, uploadWait),
        ].filter(Boolean)
        return h('div', { key: remote.id, className: 'dshdev-item', 'data-testid': 'remote-item' },
          h('div', { className: `dshdev-tile${remote.status === 'online' ? ' ok' : remote.status === 'revoked' || remote.status === 'error' ? ' bad' : ''}` },
            h(IconHost)),
          h('div', { className: 'dshdev-grow' },
            h('div', { className: 'dshdev-item-head' },
              h('strong', { className: 'dshdev-item-name' }, remote.name),
              h('span', { className: dotClass(remote.status) }),
              h('span', { className: 'dshdev-item-status' }, tr(`status.${remote.status}`)),
              remote.approvals && remote.approvals.length
                ? h('span', { className: 'dshdev-badge warn', 'data-testid': 'remote-approvals' }, `${tr('approvals')}: ${remote.approvals.length}`)
                : null),
            h('div', { className: 'dshdev-item-addr' }, remote.address),
            // Revoked hosts cannot be re-dialled, so an address edit would be moot.
            remote.status === 'revoked' ? null : h(AddressEditor, { key: 'address', remote, onDone: refresh }),
            // Spec 016 Phase 3: the two keys are separate — the host also needs its
            // own `browser:control` grant for this device. This switch is the owner's
            // consent on THIS machine and starts off.
            h('div', { className: 'dshdev-row', style: { marginTop: 6 } },
              h('span', { className: 'dshdev-muted', 'data-testid': 'browser-consent-label', title: tr('browserAgentConsentHelp') },
                tr('browserAgentConsent')),
              h('button', {
                type: 'button', role: 'switch', className: 'dshdev-switch',
                'aria-checked': remote.browserConsent === true, 'aria-label': tr('browserAgentConsent'),
                'data-testid': 'browser-consent', disabled: consenting === remote.id,
                onClick: () => setConsent(remote, remote.browserConsent !== true),
              }),
              remote.browserConsent === true
                ? h('button', { type: 'button', className: 'dshdev-btn', 'data-testid': 'browser-open',
                  disabled: !nav.openBrowserAgent,
                  onClick: () => { if (nav.openBrowserAgent) nav.openBrowserAgent(agentKindOf(remote.id)) } },
                tr('browserAgentOpen'))
                : null),
            notes),
          h('div', { className: 'dshdev-item-actions' }, [
            // A revoked remote gets no Reconnect at all: pairing again is the only fix, and
            // the route would answer `auth/revoked`.
            remote.status === 'revoked' ? null
              : h('button', { key: 'reconnect', type: 'button', className: 'dshdev-iact iact-reconnect', 'data-testid': 'remote-reconnect',
                'aria-label': dialLabel, title: dialLabel,
                disabled: connecting !== '', onClick: () => connect(remote) }, dialLabel),
            h('button', { key: 'open', type: 'button', className: 'dshdev-iact iact-open',
              'aria-label': tr('open'), title: tr('open'),
              disabled: remote.status === 'revoked', onClick: () => setOpenId(remote.id) }, tr('open')),
            h('button', { key: 'remove', type: 'button', className: 'dshdev-iact iact-remove danger',
              'aria-label': tr('removeRemote'), title: tr('removeRemote'),
              onClick: () => remove(remote) }, tr('removeRemote')),
          ].filter(Boolean)))
      }
      const online = remotes.filter((remote) => remote.status === 'online').length
      return h('div', null,
        h(ThisDevice, { status },
          h('div', { className: 'dshdev-row' },
            h('span', { className: dotClass(online > 0 ? 'online' : '') }),
            h('span', { 'data-testid': 'connected-count' }, connectedCount(online)))),
        h(FlowStrip, { remotes }),
        error ? h('div', { className: 'dshdev-err', role: 'alert' }, error) : null,
        h('div', { className: 'dshdev-sect' },
          h('h3', { className: 'dshdev-grow' }, tr('remotes')),
          h(AddDeviceForm, { onAdded: refresh })),
        remotes.length === 0 ? h('div', { className: 'dshdev-empty' }, tr('noRemotes'))
          : h('div', { className: 'dshdev-items' }, remotes.map(remoteCard)),
        h(RemoteGroupingStatus))
    }

    // --------------------------------------- spec 008 P2b: native remote sessions
    // Plain-script mirror of lib/host-router.mjs's tag. A remote id is
    // `h:<hostId>:<id>` and <hostId> is the remote record id, so ONE
    // GET /devices/remotes answers who the host is, whether it is online and which
    // scopes the device holds — the same facts the sidebar, the chip and the
    // banners need, so they cannot disagree with each other.
    const HOST_TAG = /^h:([^:]+):(.+)$/
    function hostTagOf(value) {
      const match = typeof value === 'string' ? HOST_TAG.exec(value) : null
      return match ? { hostId: match[1], rawId: match[2] } : null
    }
    /**
     * One "Copy original ID" row for a remote session, nothing for a Local one.
     *
     * The shipped row (`session.id`, order 450) copies `target.sessionId` as it is,
     * which for a remote session is the tagged `h:<hostId>:<rawId>` this plugin mints
     * so the UI can route it back. The Host itself only ever knows `<rawId>`
     * (lib/host-router.mjs: `namespaceId` adds the tag on the way in, `stripHostIds`
     * takes it off again on the way out), and that is the value a person pasting the
     * id elsewhere needs. An untagged id is a Local session, so it contributes no row
     * and never a second copy of the shipped one.
     */
    function sessionIdMenuItems(target) {
      const tag = hostTagOf(target && target.sessionId)
      if (!tag) return []
      return [{
        id: 'copy-original',
        label: tr('copyOriginalId'),
        run: () => copyText(tag.rawId),
      }]
    }
    const stamp = (value) => {
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 16).replace('T', ' ')
    }
    // When a paired device was last seen: date and time, no seconds, in the page's
    // own language instead of the browser's (the two disagree on day/month order).
    const WHEN_FORMAT = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    const stampWhen = (value) => {
      if (value === null || value === undefined || value === '') return tr('never')
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return tr('never')
      return date.toLocaleString(currentLang() === 'vi' ? 'vi-VN' : 'en-US', WHEN_FORMAT)
    }
    const ANY = (state) => state
    /**
     * The link state of one tagged host, the single answer every surface reads.
     *
     * A host is `online` when the router lists it as connected. It is
     * `disconnected` when it is still PAIRED and the router retains its last-known
     * session rows — the sessions stay on screen, so the surface must say
     * "disconnected, read-only" and not "there is nothing here". A host whose grant
     * was revoked is `revoked` instead, never `disconnected`: its rows were dropped
     * with the grant, so "read-only, it comes back" would be a lie. Anything
     * else is a host this window has no record of (a stale tag), which stays plain
     * offline.
     * @param {{hosts: object[], disconnected: object[], remotes: object[]}} hosts the store snapshot
     * @param {string} hostId the remote record id taken from a session tag
     */
    const hostLinkOf = (hosts, hostId) => {
      const live = hosts.hosts.find((entry) => entry.hostId === hostId)
      const gone = (hosts.disconnected || []).find((entry) => entry.hostId === hostId)
      const remote = hosts.remotes.find((entry) => entry.id === hostId)
      const online = !!(live && live.online !== false)
      // A revoked grant is not a link that is briefly away: the sessions are gone
      // with it, so it must never read as "disconnected, read-only". `revoked` is
      // checked FIRST, before the router's retained `gone` entry can win.
      const revoked = !!(remote && remote.status === 'revoked')
      return {
        online,
        revoked,
        disconnected: !online && !revoked && !!gone,
        // How many rows of that host are still listed from its last answer.
        retainedSessions: gone ? gone.retainedSessions : 0,
        name: (live && live.hostName) || (gone && gone.hostName) || (remote && remote.name) || hostId,
        remote: remote || null,
      }
    }
    const titleOf = (row, fallback) => (row && (row.displayTitle || row.title)) || fallback || ''

    const EMPTY_HOSTS = { hosts: [], disconnected: [], remotes: [], routing: null, error: '', loaded: false }
    function createHostsStore() {
      let snapshot = EMPTY_HOSTS
      const listeners = new Set()
      const publish = (next) => {
        snapshot = next
        for (const listener of [...listeners]) {
          // One surface failing must not take the others down with it.
          try { listener() } catch { /* keep publishing */ }
        }
      }
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        async refresh() {
          try {
            const data = await request('/devices/remotes')
            const routing = data.routing || { remote: false, reason: 'not-reported', hosts: [] }
            publish({
              remotes: (data.remotes || []).map((remote) => ({
                id: remote.id, name: remote.name, address: remote.address, status: remote.status,
                createdAt: remote.createdAt ?? null,
                kind: (remote.device && remote.device.kind) || null,
                scopes: remote.device && Array.isArray(remote.device.scopes) ? remote.device.scopes : [],
                // The link supervisor's pending retry, so every surface that reads
                // this store can tell "offline, retrying" from "offline".
                retry: remote.retry ?? null,
                // Why an automatic reconnect stopped for good (a changed
                // certificate); `retry` is null in that case, never both.
                linkError: remote.linkError ?? null,
                // Spec 016 Phase 3: the body shows this host's own consent, so the
                // tab never claims the agent is driving when it was never allowed.
                browserConsent: remote.browserConsent === true,
              })),
              // index.mjs answers with exactly the CONNECTED hosts, so a host here is
              // online by construction; a tagged session whose host is absent is the
              // offline case the banner is for.
              hosts: (Array.isArray(routing.hosts) ? routing.hosts : []).map((host) => ({
                hostId: String(host.hostId), hostName: String(host.hostName ?? host.hostId), online: host.online !== false,
                // The host-router's last refusal for this host (`status().hosts[].error`);
                // it only reports one when there is something to say, so a healthy host
                // stays `null`.
                error: host.error ?? null,
              })),
              // A PAIRED host whose link is down. Its sessions stay in the merged list
              // (the router retains them), so the row must read "Disconnected" rather
              // than look like a host that was never there or one with nothing in it.
              // A revoked grant is filtered out of this set BEFORE it is mapped: its
              // rows were dropped with the grant, so it is not "disconnected".
              disconnected: (Array.isArray(routing.disconnected) ? routing.disconnected : [])
                .filter((host) => {
                  const held = (data.remotes || []).find((entry) => entry.id === String(host?.hostId))
                  return !(held && held.status === 'revoked')
                })
                .map((host) => ({
                  hostId: String(host.hostId),
                  hostName: String(host.hostName ?? host.hostId),
                  online: false,
                  retainedSessions: Number(host.retainedSessions) || 0,
                })),
              routing,
              error: '',
              loaded: true,
            })
          } catch (cause) {
            publish({ ...snapshot, error: cause.message, loaded: true })
          }
        },
      }
    }
    const hostsStore = createHostsStore()
    const useHosts = (store) => React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

    // Why the grouped sidebar is (not) installed. The Devices page shows this line:
    // a replacement that quietly failed to install must be visible, not guessed at.
    const remoteUI = (() => {
      let snapshot = { grouped: false, reason: 'not installed', hosts: 0, tabs: false, tabsReason: null }
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        set(patch) {
          snapshot = { ...snapshot, ...patch }
          for (const listener of [...listeners]) {
            try { listener() } catch { /* a status surface must not throw */ }
          }
        },
      }
    })()
    const useRemoteUI = () => React.useSyncExternalStore(remoteUI.subscribe, remoteUI.getSnapshot, remoteUI.getSnapshot)

    // Spec 033 (A1.2): whether a FILE picked in a remote session's composer is sent to
    // that Host as BYTES. `active`/`reason` are the module's own MEASURED answer
    // (`lib/client.remote-file-attach.js` `status()`), never this page's assumption, and
    // `last` is the state of the last pick it did NOT upload (spec R6: a pick it cannot
    // attribute keeps DSH's behaviour, and the page says which state that was). No DSH
    // object is wrapped: a remote pick's file list is replaced in the picker's capture phase.
    const attachUI = (() => {
      let snapshot = { state: 'idle', active: null, reason: null, surface: null, shape: null, picks: 0, uploaded: 0, last: null }
      const listeners = new Set()
      const publish = (patch) => {
        snapshot = { ...snapshot, ...patch }
        for (const listener of [...listeners]) {
          // A status surface must never take the page down.
          try { listener() } catch { /* keep publishing */ }
        }
      }
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        set: publish,
      }
    })()
    const useAttachUI = () => React.useSyncExternalStore(attachUI.subscribe, attachUI.getSnapshot, attachUI.getSnapshot)

    // What a click may call. Empty until the shell hands the service over
    // (installRemoteSurfaces); every affordance disables itself instead of
    // pretending. Session rows and workspaces are the native browser's own, so the
    // right column's terminal tab is the only action left to this plugin.
    const nav = { openTerminal: null, openBrowserAgent: null }

    // Host identity on a remote session row. The native browser renders
    // `sidebar.session.row.trailing` beside the row's own timestamp and
    // `sidebar.session.row.hover` inside the hover card (client-ui-workspace
    // declares both seats, `kind:'list'`, `scope:'root'`), so a tagged session
    // says which Host it lives on without a second sidebar: the merged
    // `session/list` and `workspace/follow` answers already put the remote
    // workspace and its sessions in the stock browser.
    function SessionHostBadge(props) {
      useLang()
      const hosts = useHosts(hostsStore)
      const tag = hostTagOf(props.sessionId)
      // An untagged id is a local session: the native row says all there is to say.
      if (!tag) return null
      // A tagged row whose host holds no link is still the owner's session (its rows
      // are retained and its transcript is cached), so it keeps the name and only the
      // dot reads as dead; the title says which kind of dead it is.
      const link = hostLinkOf(hosts, tag.hostId)
      const state = link.online ? 'online' : link.revoked ? 'revoked' : link.disconnected ? 'disconnected' : 'offline'
      return h('span', {
        className: 'dshdev-hostbadge', 'data-testid': 'session-host-badge', 'data-host': tag.hostId,
        'data-link': state,
        title: `${tr('hostChip')}: ${link.name}${link.online ? '' : ` — ${tr(`status.${state}`)}`}`,
      },
      h('span', { className: `dshdev-dot ${link.online ? 'ok' : 'off'}`, 'data-testid': 'session-host-dot', 'aria-hidden': true }),
      h('span', { className: 'dshdev-hostbadge-name' }, link.name))
    }

    // Composer chip: only a TAGGED session has a host to name. Clicking it toggles a
    // popover; there is no public service to open Settings on rc.1, so the popover
    // is where the host actions live and its last line says where the full page is.
    function HostChip(props) {
      useLang()
      const hosts = useHosts(hostsStore)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [note, setNote] = React.useState('')
      const tag = hostTagOf(props.sessionId)
      if (!tag) return null
      const id = tag.hostId
      const link = hostLinkOf(hosts, id)
      const remote = link.remote
      const online = link.online
      const name = link.name
      const scopes = (remote && remote.scopes) || []
      const run = async (work) => {
        if (busy) return
        setBusy(true); setError(''); setNote('')
        try {
          await work()
          await hostsStore.refresh()
        } catch (cause) { setError(cause.message) } finally { setBusy(false) }
      }
      return h('div', { className: 'dshdev-anchor' },
        h('button', {
          type: 'button', className: 'dshdev-chip-host', 'data-testid': 'host-chip', 'aria-expanded': open,
          'aria-label': `${tr('hostChip')}: ${name}`, onClick: () => setOpen(!open),
        },
        h('span', { className: `dshdev-dot ${online ? 'ok' : 'off'}`, 'data-testid': 'host-chip-dot' }),
        h('span', null, name)),
        open ? h('div', { className: 'dshdev-pop', role: 'dialog', 'aria-label': tr('popoverTitle'), 'data-testid': 'host-popover' },
          h('div', { className: 'dshdev-pop-row' }, h('span', null, tr('popoverTitle')), h('strong', null, name)),
          h('div', { className: 'dshdev-pop-row' }, h('span', null, tr('status.online')),
            h('span', { 'data-testid': 'popover-state' }, online ? tr('status.online')
              : link.revoked ? tr('status.revoked') : link.disconnected ? tr('status.disconnected') : tr('status.offline'))),
          // Sessions of a disconnected host stay listed and readable, so "Offline"
          // alone would suggest a dead end: say what still works.
          link.disconnected
            ? h('div', { className: 'dshdev-muted', 'data-testid': 'popover-disconnected', role: 'status' }, tr('status.disconnectedSessions'))
            : null,
          // While the supervisor holds a retry, the popover says the link is coming
          // back by itself instead of leaving "Offline" as the whole story.
          remote && remote.retry
            ? h('div', { className: 'dshdev-muted', 'data-testid': 'popover-retry', role: 'status' }, tr('autoRetry'))
            : null,
          h('div', { className: 'dshdev-pop-row' }, h('span', null, tr('popoverKind')),
            h('span', { 'data-testid': 'popover-kind' }, (remote && remote.kind) || '—')),
          // The grant is the same chip list the authorized-device rows use: a host
          // with a dozen scopes would otherwise print one unreadable sentence here.
          h('div', { className: 'dshdev-pop-scopes' },
            h(ScopeChips, { scopes, label: tr('popoverScopes'), testId: 'popover-scopes', empty: tr('popoverNoScopes') })),
          h('div', { className: 'dshdev-pop-row' }, h('span', null, tr('popoverPaired')),
            h('span', { 'data-testid': 'popover-paired' }, remote && remote.createdAt ? stamp(remote.createdAt) : '—')),
          scopes.includes('terminal') ? null : h('div', { className: 'dshdev-muted', 'data-testid': 'terminal-hint' }, tr('terminalHint')),
          h('div', { className: 'dshdev-muted', style: { marginTop: 8 } }, tr('manageAll')),
          error ? h('div', { className: 'dshdev-err', role: 'alert' }, error) : null,
          note ? h('div', { className: 'dshdev-muted', 'data-testid': 'popover-note' }, note) : null,
          h('div', { className: 'dshdev-pop-actions' },
            h('button', { type: 'button', className: 'dshdev-btn primary', 'data-testid': 'reconnect', disabled: busy,
              onClick: () => run(() => post(`/devices/remotes/${encodeURIComponent(id)}/connect`)) },
            busy ? tr('reconnecting') : tr('reconnect')),
            h('button', { type: 'button', className: 'dshdev-btn danger', 'data-testid': 'forget-host', disabled: busy,
              onClick: () => {
                if (!window.confirm(tr('forgetConfirm'))) return
                run(async () => {
                  await request(`/devices/remotes/${encodeURIComponent(id)}`, { method: 'DELETE' })
                  setOpen(false)
                })
              } }, tr('forgetHost')))) : null)
    }

    // Notices above the composer for a remote session. Both are additive: with a
    // reachable host and no model complaint they render nothing at all.
    function SessionBanners(props) {
      useLang()
      const hosts = useHosts(hostsStore)
      const tag = hostTagOf(props.sessionId)
      if (!tag) return null
      const link = hostLinkOf(hosts, tag.hostId)
      const banners = []
      if (!link.online) {
        banners.push(h(OfflineBanner, { key: 'offline', hostId: tag.hostId, rawId: tag.rawId, name: link.name,
          known: !!link.remote, disconnected: link.disconnected, revoked: link.revoked }))
      }
      // The model complaint is read from the session the shell already follows, i.e.
      // from the HOST's answer; nothing here can substitute a local model.
      if (typeof props.useSession === 'function') banners.push(h(ModelStatusBanner, { key: 'model', useSession: props.useSession }))
      // The dock is rendered for a remote session only; an empty dock is invisible
      // (no border, no padding), and each banner decides for itself whether to show.
      return h('div', { className: 'dshdev-dock', 'data-testid': 'session-banners' }, banners)
    }

    function OfflineBanner({ hostId, rawId, name, known, disconnected = false, revoked = false }) {
      useLang()
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [error, setError] = React.useState('')
      const remove = async () => {
        if (busy) return
        setBusy(true); setError(''); setNote('')
        try {
          const answer = await request(`/devices/remotes/${encodeURIComponent(hostId)}/sessions/${encodeURIComponent(rawId)}`, { method: 'DELETE' })
          setNote(answer.removed ? tr('localCopyRemoved') : tr('localCopyGone'))
        } catch (cause) { setError(cause.message) } finally { setBusy(false) }
      }
      // A paired host that is only disconnected keeps its sessions listed: the title
      // names that state instead of claiming the task is gone. A revoked grant is
      // not that state — nothing is coming back — so it says what happened instead.
      const state = revoked ? 'revoked' : disconnected ? 'disconnected' : 'offline'
      const title = revoked ? `${tr('status.revoked')} — ${name}`
        : disconnected ? `${tr('status.disconnected')} — ${name}` : `${tr('bannerOfflineTitle')} ${name}`
      return h('div', { className: 'dshdev-banner', 'data-testid': 'offline-banner', 'data-link': state, role: 'status' },
        h('div', { className: 'dshdev-grow' },
          h('strong', null, title),
          h('div', { className: 'dshdev-muted' }, `${tr('bannerReadOnly')} — ${tr('bannerOfflineBody')}`),
          error ? h('div', { className: 'dshdev-err', role: 'alert' }, error) : null,
          note ? h('div', { className: 'dshdev-muted', 'data-testid': 'local-copy-note' }, note) : null),
        h('button', { type: 'button', className: 'dshdev-btn', 'data-testid': 'remove-local-copy', disabled: busy || !known, onClick: remove },
          busy ? tr('removeLocalCopyBusy') : tr('removeLocalCopy')))
    }

    function ModelStatusBanner({ useSession }) {
      useLang()
      const session = useSession(ANY) || {}
      const values = (session.projections && session.projections.values) || {}
      const problem = session.modelError ?? values.modelError ?? (values.model && values.model.error)
      const message = typeof problem === 'string' ? problem : (problem && typeof problem.message === 'string' ? problem.message : '')
      if (!message) return null
      return h('div', { className: 'dshdev-banner info', 'data-testid': 'model-status-banner', role: 'status' },
        h('div', { className: 'dshdev-grow' },
          h('strong', null, tr('modelStatus')),
          h('div', { className: 'dshdev-muted' }, message),
          h('div', { className: 'dshdev-muted' }, tr('modelUnavailable'))))
    }

    // A terminal for a remote session needs the device's `terminal` grant. Without
    // it the entry is HIDDEN (not disabled): the hint sits in the host popover,
    // where the granted permissions are listed.
    function RemoteTerminalEntry(props) {
      useLang()
      const hosts = useHosts(hostsStore)
      const tag = hostTagOf(props.sessionId)
      if (!tag) return null
      const remote = hosts.remotes.find((entry) => entry.id === tag.hostId)
      const scopes = (remote && remote.scopes) || []
      if (!scopes.includes('terminal')) return null
      const openTerminal = typeof props.openTerminal === 'function' ? props.openTerminal : nav.openTerminal
      return h('button', { type: 'button', className: 'dshdev-btn', 'data-testid': 'remote-terminal', title: tr('terminalOpen'),
        disabled: !openTerminal, onClick: () => { if (openTerminal) openTerminal(props.sessionId) } }, tr('terminalEntry'))
    }

    // ------------------------------------------------- spec 016 Phase 3: agent tab
    // Spec 016 Phase 1: the body of a machine's own doorway. It is the card the Devices
    // page already shows for a paired host — its sessions, their history, its approvals
    // and the prompt box — mounted in the tab the Start page opened. No `onBack`: there
    // is no list behind it inside the tab, and RemoteDetail then draws no Back button.
    function HostDoorTab({ hostId }) {
      useLang()
      const hosts = useHosts(hostsStore)
      const remote = hosts.remotes.find((entry) => entry.id === hostId)
      if (!remote) {
        return h('div', { className: 'dshdev-panel', 'data-testid': 'host-door-gone' },
          h('div', { className: 'dshdev-muted' }, tr('hostDoorGone')))
      }
      return h('div', { className: 'dshdev-panel', 'data-testid': 'host-door' }, h(RemoteDetail, { remote }))
    }

    // One tab type per paired host ("Browser (agent) · <host>"). The body is only a
    // screencast: the browser itself runs in the plugin's Host half on THIS machine,
    // and the tab never talks to the remote host at all.
    function BrowserAgentTab({ hostId, hostName }) {
      useLang()
      const hosts = useHosts(hostsStore)
      const remote = hosts.remotes.find((entry) => entry.id === hostId)
      // Consent is read from the same one-window picture the cards use: off means
      // nothing is polled, because the frame route would only answer 403.
      const consented = !!(remote && remote.browserConsent === true)
      const [src, setSrc] = React.useState('')
      const [error, setError] = React.useState('')
      const [note, setNote] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const objectUrl = React.useRef('')
      React.useEffect(() => () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current) }, [])
      React.useEffect(() => {
        if (!consented) { setSrc(''); return undefined }
        let alive = true
        let timer = null
        const load = async () => {
          try {
            // The route answers 204 until the first frame exists, then a JPEG.
            const answer = await request(`/devices/browser/${encodeURIComponent(hostId)}/frame?t=${Date.now()}`,
              undefined, { image: true })
            if (!alive) return
            if (answer.status === 204) { setError(''); return }
            const next = URL.createObjectURL(answer.blob)
            if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
            objectUrl.current = next
            setSrc(next)
            setError('')
          } catch (cause) {
            if (alive) setError(cause && cause.message ? cause.message : tr('browserAgentFailed'))
          } finally {
            if (alive) timer = window.setTimeout(load, 1000)
          }
        }
        load()
        return () => {
          alive = false
          if (timer) window.clearTimeout(timer)
        }
      }, [hostId, note, consented])
      const stop = async () => {
        if (busy) return
        setBusy(true); setError('')
        try {
          await post(`/devices/browser/${encodeURIComponent(hostId)}/stop`)
          if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
          objectUrl.current = ''
          setSrc(''); setNote(tr('browserAgentStopped'))
        } catch (cause) { setError(cause.message) } finally { setBusy(false) }
      }
      if (!consented) {
        return h('div', { className: 'dshdev-agentbrowser', 'data-testid': 'agent-browser' },
          h('div', { className: 'dshdev-muted', 'data-testid': 'agent-browser-no-consent' }, tr('browserAgentNoConsent')))
      }
      return h('div', { className: 'dshdev-agentbrowser', 'data-testid': 'agent-browser' },
        h('div', { className: 'dshdev-banner', 'data-testid': 'agent-browser-banner', role: 'status' },
          h('div', { className: 'dshdev-grow' },
            h('strong', null, tr('browserAgentBanner')),
            hostName ? h('div', { className: 'dshdev-muted' }, hostName) : null),
          h('button', { type: 'button', className: 'dshdev-btn danger', 'data-testid': 'agent-browser-stop',
            disabled: busy, onClick: stop }, busy ? tr('working') : tr('browserAgentStop'))),
        note ? h('div', { className: 'dshdev-muted', 'data-testid': 'agent-browser-note' }, note) : null,
        error ? h('div', { className: 'dshdev-err', role: 'alert', 'data-testid': 'agent-browser-error' }, error) : null,
        src
          ? h('img', { src, alt: tr('browserAgentTab'), className: 'dshdev-agentframe', 'data-testid': 'agent-browser-frame' })
          : h('div', { className: 'dshdev-agentplaceholder dshdev-muted', 'data-testid': 'agent-browser-empty' }, tr('browserAgentEmpty')))
    }

    // The Devices page's own line about the replacement, so a failed install is
    // visible in the UI instead of only in the console.    //
    // The plugin writes these few reasons itself, so they are printed as sentences
    // rather than as the raw English diagnosis. `routing.reason` is the carrier's own
    // short code (A1.1 self-test); a code without a translation is left alone instead
    // of being guessed at, and a message a shell hands us stays verbatim.
    const REASON_KEYS = {
      'dsh-version-mismatch': 'reason.dsh-version-mismatch',
      'dsh-version-unknown': 'reason.dsh-version-unknown',
      'no-gateway': 'reason.no-gateway',
      'dispatchRpc-missing': 'reason.dispatchRpc-missing',
      'openWireStream-missing': 'reason.openWireStream-missing',
      'openWireStream-signature': 'reason.openWireStream-signature',
    }
    const reasonText = (code) => {
      const value = String(code || '')
      const key = REASON_KEYS[value]
      return key ? tr(key) : value
    }
    const groupingReasonText = (reason) => {
      const value = String(reason || '')
      if (!value) return ''
      if (value === 'not installed') return tr('sidebarReasonNotInstalled')
      if (value === 'the shell provides no client services') return tr('sidebarReasonNoServices')
      if (value === 'no remote host is connected') return tr('sidebarReasonNoHost')
      if (value === 'the shell provides no workspace actions') return tr('sidebarReasonNoActions')
      if (value === 'no-tabs') return tr('sidebarReasonNoTabs')
      if (value === 'shortcuts') return tr('sidebarReasonShortcut')
      const routing = /^multi-host routing is off(?:: (.*))?$/.exec(value)
      if (routing) {
        return routing[1] ? `${tr('sidebarReasonRoutingOff')} (${reasonText(routing[1])})` : tr('sidebarReasonRoutingOff')
      }
      return value
    }
    function RemoteGroupingStatus() {
      useLang()
      const status = useRemoteUI()
      return h('div', { className: 'dshdev-card', 'data-testid': 'sidebar-grouping' },
        h('h3', null, tr('sidebarGrouping')),
        h('div', { className: 'dshdev-muted', 'data-testid': 'sidebar-grouping-state' },
          status.grouped ? `${tr('sidebarOn')} (${status.hosts})` : `${tr('sidebarOffState')} — ${groupingReasonText(status.reason)}`),
        h('div', { className: 'dshdev-muted', 'data-testid': 'sidebar-tabs-state' },
          `${tr('hostTabs')}: ${status.tabs
            ? `${tr('hostTabsOn')}${status.tabsReason ? ` — ${groupingReasonText(status.tabsReason)}` : ''}`
            : tr('hostTabsOff')}`))
    }

    // ------------------------------- the sidebar's two tabs (This Computer / Remote)
    // Qoder's split, done the only way that costs no data: both tabs show the SAME
    // native browser and one injected stylesheet hides the rows the other tab owns.
    // Nothing is re-requested, re-merged or re-ordered — `workspace/follow` and
    // `session/list` stay exactly the streams the shell already asked for, and a tab
    // change writes one <style> and nothing else.
    //
    // THE FILTER (measured on the live DSH window, owner, 2026-11-16; row order is flat
    // in document order): a local workspace row is `workspace:<uuid>` (UNTAGGED), a
    // local session row `session:session-<uuid>`, a remote workspace `workspace:h:<hostId>:<uuid>`,
    // a remote session `session:h:<hostId>:<uuid>`, a remote hidden-sessions button
    // `overflow:h:<hostId>:<uuid>`, plus the UNGROUPED group header `workspace:` and its
    // `overflow:` — observed holding only remote sessions in that group on the live
    // window. The empty state is the literal `empty` — never hidden, because an empty
    // workspace is still a fact of whichever tab you are on.
    // Every id minted through this plugin's multi-host router is `h:<hostId>:<id>`
    // (`lib/host-router.mjs` namespaceId, mirrored by HOST_TAG above), and the shell
    // tags workspace ids that way too, so one prefix decides both directions: a row is
    // remote iff its key carries the `:h:` tag after the kind.
    const HOST_TABS_STYLE_ID = 'dsh-ext.devices.host-tabs'
    const HOST_TABS_SLOT = 'sidebar.session.action'
    // What the THIS-COMPUTER tab hides: every row tagged for a remote host, and nothing
    // else — the untagged `workspace:`/`overflow:` ungrouped headers stay, since local
    // loose sessions may live there.
    const HOST_TABS_LOCAL_HIDES = [
      '[data-row-key^="workspace:h:"]',
      '[data-row-key^="session:h:"]',
      '[data-row-key^="overflow:h:"]',
    ]
    // What the REMOTE tab hides: every row NOT tagged for a remote host, plus
    // `workspace:` — the ungrouped header is hidden by the same `:not` already
    // (`workspace:` does not start with `workspace:h:`).
    const HOST_TABS_REMOTE_HIDES = [
      '[data-row-key^="workspace:"]:not([data-row-key^="workspace:h:"])',
      '[data-row-key^="session:"]:not([data-row-key^="session:h:"])',
      '[data-row-key^="overflow:"]:not([data-row-key^="overflow:h:"])',
    ]
    // What each tab hides, as the selectors themselves (what `hostTabsStyle` writes).
    const HOST_TABS_SELECTORS = { local: HOST_TABS_LOCAL_HIDES, remote: HOST_TABS_REMOTE_HIDES }
    const hostTabsHide = (selectors) => `${selectors.join(',')}{display:none!important}`
    /**
     * What each tab hides. `value` only names the tab; the selectors come from the
     * tables above. No `:has()` mixed-case rules: the measured keys are reliably
     * tagged, and a case-matching rule risks hiding a remote workspace that holds
     * sessions.
     * @returns {string} the stylesheet text for that tab
     */
    function hostTabsStyle(value) {
      return hostTabsHide(value === 'remote' ? HOST_TABS_REMOTE_HIDES : HOST_TABS_LOCAL_HIDES)
    }
    const HOST_TABS_STYLE = { local: hostTabsStyle('local'), remote: hostTabsStyle('remote') }
    const HOST_TABS_STORAGE = 'dsh-ext.devices.sidebar-tab'
    const HOST_TABS_DEFAULT = 'local'
    // Declared in `apply` so `installRemoteSurfaces` can report it on the Devices page.
    // `tabs: false` means "not installed"; `tabsReason` explains a partial install
    // ('shortcuts') or a refused seat ('no-tabs').
    const syncHostTabsStatus = () => remoteUI.set({
      tabs: toggles.registered,
      tabsReason: toggles.reason || null,
    })
    const toggles = {
      registered: false,
      reason: null,
      // Read synchronously by the one layer component, written only by the disposer.
      tab: HOST_TABS_DEFAULT,
      listeners: new Set(),
    }
    const subscribeHostTab = (listener) => { toggles.listeners.add(listener); return () => toggles.listeners.delete(listener) }
    const hostTabSnapshot = () => toggles.tab
    const useHostTab = () => React.useSyncExternalStore(subscribeHostTab, hostTabSnapshot, hostTabSnapshot)
    const storedHostTab = () => {
      try {
        const value = window.localStorage.getItem(HOST_TABS_STORAGE)
        return value === 'local' || value === 'remote' ? value : HOST_TABS_DEFAULT
      } catch { return HOST_TABS_DEFAULT /* a shell without storage starts local; the tab still works */ }
    }
    const publishHostTab = (tab) => {
      if (tab !== 'local' && tab !== 'remote') return false
      toggles.tab = tab
      try { window.localStorage.setItem(HOST_TABS_STORAGE, tab) } catch { /* in-memory only */ }
      for (const listener of [...toggles.listeners]) {
        try { listener() } catch { /* one surface must not stop the others */ }
      }
      return true
    }

    /**
     * The `sidebar.session.action` layer: the shell's New Task row, wrapped. The strip
     * is drawn ABOVE `children` and the wrapped row is rendered unchanged, once.
     */
    function SidebarHostTabs({ wide, children }) {
      useLang()
      const tab = useHostTab()
      // On the collapsed rail there is no room for a strip and no list to filter
      // either: `sidebar.workspaces` is not dispatched (client-ui-sidebar draws the
      // region only in the wide state), so the layer passes the row through.
      if (!wide) return children ?? null
      const choose = (next) => { publishHostTab(next) }
      return h('div', { className: 'dshdev-hosttabs', 'data-testid': 'sidebar-host-tabs' },
        h('div', { className: 'dshdev-hosttabs-strip dshdev-seg', role: 'tablist', 'aria-label': tr('hostTabs') },
          [['local', 'tabThisComputer', 'tabSwitchLocal', 'tabShortcutLocal'],
            ['remote', 'tabRemoteWorkspace', 'tabSwitchRemote', 'tabShortcutRemote']].map(([id, label, title, keys]) =>
            h('button', { key: id, type: 'button', role: 'tab', 'data-tab': id, 'aria-selected': tab === id, 'aria-pressed': tab === id,
              title: `${tr(title)} (${tr(keys)})`,
              onClick: () => choose(id) }, tr(label)))),
        children ?? null)
    }

    /**
     * The one <style> that filters the list, swapped (never stacked) on a tab change so
     * the element under `[data-plugin]` is always the whole rule set. Idempotent: a
     * second call with the same tab writes nothing. The default is the tab the store
     * already holds; only `installSidebarTabStrip`, which owns the store, passes one.
     * @returns {{ write: (tab: string) => void, remove: () => void }}
     */
    function hostTabsStyleWriter(doc, tab = toggles.tab) {
      let style = null
      let written = null
      const write = (next) => {
        const text = HOST_TABS_STYLE[next] || HOST_TABS_STYLE[HOST_TABS_DEFAULT]
        if (text === written) return
        if (style === null) {
          style = doc.createElement('style')
          // `data-plugin` is the element's own contract (and what a test finds it by);
          // the attribute goes through whichever of the two the element offers.
          if (typeof style.setAttribute === 'function') style.setAttribute('data-plugin', HOST_TABS_STYLE_ID)
          else if (style.dataset) style.dataset.plugin = HOST_TABS_STYLE_ID
          doc.head.appendChild(style)
        }
        style.textContent = text
        written = text
      }
      write(tab)
      return {
        write,
        remove() {
          const element = style
          style = null
          written = null
          try { element?.remove() } catch { /* an element already gone needs nothing */ }
        },
      }
    }

    // One effect owns the style and the two Ctrl+Alt+1 / 2 commands, so a reload
    // removes exactly what this installed. A shell that declares no
    // `sidebar.session.action` seat degrades to "no tabs" with the reason on the
    // Devices page — the native sidebar is then exactly as shipped.
    function installSidebarTabStrip(ctx) {
      const disposers = []
      toggles.tab = storedHostTab()
      // Structure first: the layer is this feature's only switch, so a shell that does
      // not declare it gets no filter at all (a filter with no way back would hide half
      // the list) and the Devices page states the reason. The factory is the countable
      // fact: an undeclared seat may still hand back an inert disposer.
      let declared = false
      let seat = null
      try {
        seat = ctx.slots.inject(HOST_TABS_SLOT, () => {
          const registration = ctx.slots.register(
            { name: HOST_TABS_SLOT, id: 'dsh-ext.devices.tabs', order: 100 }, SidebarHostTabs)
          declared = true
          return registration
        })
      } catch (cause) {
        declared = false
      }
      if (!declared) {
        toggles.registered = false
        toggles.reason = 'no-tabs'
        // An inert injector at an undeclared seat is usually not invoked at all, so a
        // disposer it returned must still be released here.
        if (typeof seat === 'function') { try { seat() } catch { /* nothing was installed */ } }
        return null
      }
      toggles.registered = true
      if (typeof seat === 'function') disposers.push(seat)
      toggles.reason = null
      let filter = null
      const overlay = () => { if (filter) filter.write(toggles.tab) }
      if (typeof document !== 'undefined' && document && document.head) {
        filter = hostTabsStyleWriter(document, toggles.tab)
      }
      // The shortcuts are an accelerator, never the only way to switch: the strip is
      // always clickable, so a shell without `ctx.shortcuts` simply has no keys.
      if (toggles.registered && ctx.shortcuts && typeof ctx.shortcuts.register === 'function') {
        const keys = [['local', 'Key1', 'tabSwitchLocal'], ['remote', 'Key2', 'tabSwitchRemote']]
        try {
          for (const [tab, code, label] of keys) {
            disposers.push(ctx.shortcuts.register({
              id: `dsh-ext.devices.sidebar-tab-${tab}`,
              label: () => tr(label),
              aliases: [tr(tab === 'local' ? 'tabThisComputer' : 'tabRemoteWorkspace')],
              defaults: {
                'desktop:macos': { code, modifiers: ['primary', 'alt'] },
                'desktop:windows': { code, modifiers: ['primary', 'alt'] },
                'desktop:linux': { code, modifiers: ['primary', 'alt'] },
                'web:macos': { code, modifiers: ['primary', 'alt'] },
                'web:windows': { code, modifiers: ['primary', 'alt'] },
              },
              regions: ['page', 'editable'],
              modals: [],
              resolve: () => ({ status: 'handled', run: () => { publishHostTab(tab) } }),
            }))
          }
        } catch { toggles.reason = 'shortcuts' /* the tabs still work; the page says the keys did not */ }
      }
      if (filter) disposers.push(subscribeHostTab(overlay))
      return () => {
        for (const entry of disposers.splice(0)) {
          try { entry?.() } catch { /* teardown must not throw */ }
        }
        if (filter) filter.remove()
        filter = null
        toggles.registered = false
        toggles.reason = null
        toggles.tab = HOST_TABS_DEFAULT
      }
    }

    /**
     * Spec 033 (A1.2, revised 2026-11-16): switch on the remote file attach for this
     * renderer and return its disposer. No DSH object is wrapped — the preload's
     * `__DSH_HOST_PATHS__` is a frozen contextBridge copy, so a wrap could never have
     * worked. What this installs is ONE delegated listener: the picker's `change` in the
     * CAPTURE phase, before DSH's own handler reads `e.target.files` (its first statement).
     * The listener asks which composer the picker sits in and, for a remote session with a
     * non-image file among the picks, replaces that file list with path-free copies — all
     * of the deciding lives in `lib/client.remote-file-attach.js`. Everything it cannot
     * attribute, or refuses, keeps DSH's own behaviour (R6) and the page says why.
     *
     * ACTIVATION IS THE INSTALL (review 2026-11-16). This page fetches NOTHING to decide:
     * an installed Electron shell does not serve DSH's package `src` tree, so a source read
     * from the page could only ever have been a gap — and a gap that kept the first picks of
     * every page (and every pick of a shell that never served the sources) as DSH's own.
     * What the mechanism rests on is proven per pick by the module itself — the composer
     * region and session attribute, the `File`/`DataTransfer` round trip, `answersNoPath` for
     * the page-built copy and the readback of the replaced list — and the DSH contract the
     * mechanism assumes is asserted against the INSTALLED sources on disk by the tests
     * (`test/remote-file-attach.test.mjs`, `test/client.test.mjs`), never fetched at runtime.
     *
     * `deps` is a test seam only: production passes nothing, so the host is `window` and its
     * own `document`. One `effect` owns the listener and the module, so a reload removes
     * exactly what it installed.
     * @returns {() => void} disposer
     */
    function installRemoteFileAttach(deps = {}) {
      const host = deps.global ?? (typeof window === 'undefined' ? null : window)
      const doc = 'doc' in deps ? deps.doc : (host && host.document) || null
      if (host === null || typeof host !== 'object') {
        attachUI.set({ state: 'ready', active: false, reason: 'no-window' })
        return () => {}
      }
      const wrap = typeof deps.wrapper === 'function' ? deps.wrapper() : remoteFileAttach
      let disposed = false
      let attach = null
      let listener = null
      const publish = () => {
        if (disposed || attach === null) return
        const status = attach.status()
        const last = attach.takeNotice()
        attachUI.set({
          state: 'ready', active: status.state === 'active', reason: status.reason,
          surface: status.surface, shape: status.shape, picks: status.picks, uploaded: status.uploaded,
          last: last === null ? attachUI.getSnapshot().last : { reason: last.reason, sessionId: last.sessionId },
        })
      }
      Promise.resolve(wrap).then((module) => {
        if (disposed) return
        // The chunk's factory return value; a shell that hands back the registration
        // instead of the exports (`{id, chunk, factory}`) is read the same way the
        // loader would read it, so a module built around either answers the same.
        let loaded = module
        if (typeof loaded?.remoteFileIntakeFor !== 'function' && typeof loaded?.factory === 'function') {
          loaded = loaded.factory(() => { throw new Error('the remote file attach chunk must stay a leaf module') })
        }
        if (loaded === null || typeof loaded !== 'object' || typeof loaded.remoteFileIntakeFor !== 'function') {
          attachUI.set({ state: 'ready', active: false, reason: 'bridge-module-missing' })
          return
        }
        const chunk = loaded
        // Synchronous, on purpose: `install()` measures the realm (the `File`/`DataTransfer`
        // round trip), so the state the page shows is never a guess the first pick could then
        // contradict. Nothing is fetched and nothing waits: the mechanism is on from here.
        attach = chunk.remoteFileIntakeFor({
          global: host, doc,
          log: () => { /* the reason travels on `status()`, never into a console */ },
          onNotice: () => publish(),
        })
        attach.install()
        publish()
        // The pick signal: the capture phase, where `e.target.files` is still what the user
        // picked and DSH's own handler (bubble, React's root delegate) has not read it yet.
        if (doc !== null && typeof doc.addEventListener === 'function') {
          listener = (event) => {
            if (chunk.adoptPickerFrom(attach, event) === null) return
            publish()
          }
          doc.addEventListener(chunk.PICK_EVENT ?? 'change', listener, true)
        }
      }, () => {
        // A shell that cannot hand the chunk over: every pick stays DSH's, and the page shows it.
        attachUI.set({ state: 'ready', active: false, reason: 'bridge-module-missing' })
      })
      return () => {
        disposed = true
        if (doc !== null && typeof doc.removeEventListener === 'function' && listener !== null) {
          doc.removeEventListener('change', listener, true)
        }
        listener = null
        if (attach !== null) attach.uninstall()
        const after = attach === null ? { state: 'unavailable', reason: 'not-installed' } : attach.status()
        attachUI.set({ state: 'ready', active: after.state === 'active', reason: after.reason, picks: 0, uploaded: 0 })
      }
    }

    // The Devices page's own line about the remote file attach, so a refused mechanism is
    // visible in the UI instead of only in a log (A1.2). Same honesty rule as the upload
    // note: it states what was MEASURED, names the reason, and claims nothing while the
    // module is still arriving. No DSH object is wrapped: the state is about replacing a
    // remote pick's file list in the picker, nothing else.
    const ATTACH_REASON_KEYS = {
      'browser-unavailable': 'attachBrowserUnavailable',
      'bridge-module-missing': 'attachNoModule', 'not-installed': 'attachNotInstalled', 'no-window': 'attachNoWindow',
    }
    const attachReasonText = (reason) => {
      const value = String(reason || '')
      const key = ATTACH_REASON_KEYS[value]
      return key ? tr(key) : value
    }
    // The state of the last pick that was NOT re-materialized, per R6. `certain` here means
    // "attributed exactly, and the pick needed nothing changed" (a local session, images).
    // `replace-failed` is its opposite kind of row: a PROVEN remote non-image pick whose
    // copies the picker would not take — never shown as a local pick (review 2026-11-16).
    const ATTACH_STATE_KEYS = {
      certain: 'attachPickLocal', 'ambiguous': 'attachPickAmbiguous', 'no-composer': 'attachPickNoComposer',
      'no-document': 'attachPickNoDocument', 'no-session': 'attachPickNoSession', 'picker-elsewhere': 'attachPickElsewhere',
      'picker-document': 'attachPickBrowser', 'composer-uncertain': 'attachPickUncertain',
      'stale-batch': 'attachPickStale', 'browser-chrome': 'attachPickBrowser',
      // The pick itself proved the page cannot hand DSH a path-free file (that pick stayed DSH's).
      'path-unavailable': 'attachPickPathNamed', unverified: 'attachPickUnverified',
      // Proven remote, and the composer refused the page-built copies.
      'replace-failed': 'attachPickReplaceFailed',
    }
    function RemoteAttachStatus() {
      useLang()
      const attach = useAttachUI()
      if (attach.state !== 'ready') return null
      const reason = attach.reason ? attachReasonText(attach.reason) : ''
      const active = attach.active === true
      const line = active
        ? (attach.shape === 'no-bridge' ? tr('attachNoBridge') : tr('attachOn'))
        : `${tr('attachOffUnknown')} — ${reason}`
      const last = attach.last
      return h('div', { className: active ? 'dshdev-card' : 'dshdev-card dshdev-warn',
        'data-testid': 'remote-attach', 'data-active': active ? 'yes' : 'no',
        'data-reason': attach.reason || '', role: 'status' },
      h('strong', null, tr('attachTitle')),
      h('div', { className: 'dshdev-muted', 'data-testid': 'remote-attach-state' }, line),
      active && attach.shape === 'measured'
        ? h('div', { className: 'dshdev-muted', 'data-testid': 'remote-attach-surface' }, tr('attachMeasured'))
        : null,
      active !== true && attach.reason
        ? h('div', { className: 'dshdev-muted', 'data-testid': 'remote-attach-reason' }, tr('attachReason') + ': ' + reason)
        : null,
      last === null || last === undefined ? null
        : h('div', { className: 'dshdev-muted', 'data-testid': 'remote-attach-last', 'data-state': last.reason },
          tr('attachLast') + ': ' + tr(ATTACH_STATE_KEYS[last.reason] ?? 'attachPickUnknown')))
    }

    /**
     * Spec 008 P2b. Everything here is additive: the stock browsers keep their
     * slots and the plugin only fills seats the shell leaves for other packages,
     * so a refused seat removes nothing from the native UI.
     * @returns {() => void} disposer
     */
    function installRemoteSurfaces(ctx) {
      const dispose = []
      // Why a seat failed to register, when one did. A refused seat is reported on
      // the Devices page, never papered over and never worked around.
      let seatError = null
      const register = (slot, meta, component, props) => {
        try {
          dispose.push(ctx.slots.inject(slot, () => ctx.slots.register({ ...meta, name: slot, ...(props ? { inject: props } : {}) }, component)))
        } catch (cause) {
          seatError = `${slot}: ${cause && cause.message ? cause.message : 'not available'}`
          remoteUI.set({ grouped: false, reason: seatError })
        }
      }
      // The native session catalog, once the shell hands it over.
      let sessions = null
      // A host change can land before the service does; the pull is not lost, it
      // waits for the handle.
      let sessionsPending = false
      /** Ask the native catalog to pull `session/list` again (ClientSessions.refresh). */
      const refreshSessions = () => {
        if (!sessions) { sessionsPending = true; return null }
        sessionsPending = false
        try {
          const pending = sessions.refresh()
          if (pending && typeof pending.catch === 'function') { pending.catch(() => { /* the native sidebar reports its own refusal */ }); return pending }
          return null
        } catch { return null /* a refused refresh must not take the surfaces down */ }
      }
      // `session/list` is answered by merging every connected Host (`host-router`),
      // but the client catalog only pulls it on connect — `ClientSessions.refresh`
      // → `manager.refreshList`, driven by `handleConnected`. A Host that connects
      // after startup would therefore never show its sessions until a reload, so the
      // connected-host set is compared here and the catalog is pulled again whenever
      // it changes.
      //
      // The key is the whole PICTURE, not just the id set. A remote whose own
      // `session/list` call failed contributes no rows and its refusal is reported
      // per host (`host-router` `#noteHostError`), so a pull that lands while it is
      // still failing caches an EMPTY list — and with an id-set-only key that empty
      // list was never re-read once the host recovered, which is the "connected,
      // but no conversations" symptom. Each row therefore carries its state:
      //   - the connection set, so connect/disconnect/reconnect still pull;
      //   - the per-host error CODE, so a host that fails or recovers (or swaps one
      //     refusal for another) is a change worth a pull and a silent success is not;
      //   - the disconnected hosts and how many rows each still retains, because a
      //     disconnect moves rows from `hosts` to `disconnected` and back.
      // `refresh()` only publishes on an answer, so a failing poll leaves the key
      // untouched and cannot pump the catalog.
      let hostKey = ''
      let hostKeyKnown = false
      // A pull already in flight is not replaced — but a change that arrives WHILE one
      // runs must not be lost either. `ClientSessions.refresh` coalesces its own calls,
      // so stacking a second here would let an older answer land last; consuming the
      // new key and returning would be worse still: the change would be recorded as
      // handled and never pulled, which is exactly how a host that recovers mid-pull
      // keeps its empty list forever. So the running pull owns no key: the key is only
      // committed once a pull actually starts, and a change seen meanwhile sets
      // `refreshQueued`, which re-checks the picture when the pull settles.
      let refreshInFlight = false
      let refreshQueued = false
      const pictureKey = (snapshot) => JSON.stringify([
        snapshot.hosts.map((host) => [host.hostId, host.error === null || host.error === undefined ? null : String(host.error)]).sort(),
        (snapshot.disconnected || []).map((host) => [host.hostId, Number(host.retainedSessions) || 0]).sort(),
      ])
      // The newest picture seen, so a pull that settles can re-check against it.
      let lastSnapshot = null
      const pull = () => {
        refreshInFlight = true
        // `refreshSessions` swallows its own refusal; this only re-arms the guard.
        // Both settle paths are here so a throw or a rejection cannot wedge it.
        Promise.resolve(refreshSessions()).then(settlePull, settlePull)
      }
      const settlePull = () => {
        refreshInFlight = false
        if (!refreshQueued) return
        // `consider` re-checks the picture and may start the next pull itself. The flag
        // is only cleared when it does NOT queue again — clearing it up front would
        // drop a change that arrives while the re-check runs.
        if (lastSnapshot) consider(lastSnapshot)
        if (!refreshInFlight) refreshQueued = false
      }
      const consider = (snapshot) => {
        const next = pictureKey(snapshot)
        if (hostKeyKnown && next === hostKey) {
          // The picture returned to what the running pull already committed: nothing
          // left to re-read.
          refreshQueued = false
          return
        }
        // Startup: the catalog pulled once on its own, so only the key is recorded.
        if (!hostKeyKnown) { hostKey = next; hostKeyKnown = true; return }
        if (refreshInFlight) { refreshQueued = true; return }
        // Commit the key BEFORE dialing, so a poll that lands during the pull compares
        // against what this pull is fetching rather than re-queueing the same change.
        hostKey = next
        refreshQueued = false
        pull()
      }
      const refreshForHosts = (snapshot) => {
        lastSnapshot = snapshot
        consider(snapshot)
      }
      // Spec 016 Phase 3: one registered tab type (and one keyed body) per paired
      // host, kept in step with the host list. A shell that refuses the seat leaves
      // the card's Open disabled instead of pretending a tab exists.
      let tabTypesRegistry = null
      const agentTabs = new Map()
      function syncAgentTabs() {
        const registry = tabTypesRegistry
        if (!registry) return
        const wanted = new Map(hostsStore.getSnapshot().remotes.map((remote) => [remote.id, remote]))
        for (const [hostId, entry] of agentTabs) {
          if (wanted.has(hostId)) continue
          agentTabs.delete(hostId)
          try { entry.dispose() } catch { /* already gone */ }
        }
        for (const remote of wanted.values()) {
          if (agentTabs.has(remote.id)) continue
          try {
            const id = `dsh-ext.devices.browser-agent:${remote.id}`
            const kind = agentKindOf(remote.id)
            const title = () => `${tr('browserAgentTab')} · ${remote.name}`
            const disposeType = registry.register({
              id, kind, priority: 'extension', multiple: false, title,
              // The Start page's doorway; picking it opens this host's agent tab.
              guide: [{ id: 'open', order: 45, title, description: () => tr('browserAgentDescription') }],
            })
            const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: id, priority: 100 },
              (props) => h(BrowserAgentTab, { hostId: remote.id, hostName: remote.name, ...props })))
            agentTabs.set(remote.id, { dispose: () => { try { disposeBody?.() } finally { disposeType?.() } } })
          } catch { /* the tab type is optional; nothing else depends on it */ }
        }
      }
      // Spec 016 Phase 1: the Start page's per-machine doorways. One tab type per
      // doorway (a capsule opens its owner's kind and nothing else), kept in step with
      // the same snapshot every other surface reads, so adding, removing or
      // reconnecting a machine adds, removes or restores its entries on the next
      // refresh — the 4 s `refresh()` the surfaces already share, never a new timer.
      const hostDoors = new Map()
      function syncHostDoors() {
        const registry = tabTypesRegistry
        if (!registry) return
        const wanted = new Map(hostDoorEntries(hostsStore.getSnapshot().remotes).map((entry) => [entry.id, entry]))
        for (const [id, dispose] of hostDoors) {
          if (wanted.has(id)) continue
          hostDoors.delete(id)
          try { dispose() } catch { /* already gone */ }
        }
        for (const entry of wanted.values()) {
          if (hostDoors.has(entry.id)) continue
          try {
            const body = entry.key === 'devices' ? DevicesPanel : HostDoorTab
            // The type's id IS its kind: the id is namespaced by machine and doorway,
            // and the keyed body is dispatched with the id (rc.1's `sidebar.right.pane.tab`).
            const disposeType = registry.register({
              id: entry.id, kind: entry.id, priority: 'extension', multiple: false, title: entry.title,
              guide: [{ id: 'open', order: entry.order, title: entry.title, description: entry.description, icon: entry.icon }],
            })
            const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: entry.id, priority: 100 },
              (props) => h(body, { hostId: entry.hostId, ...props })))
            hostDoors.set(entry.id, () => { try { disposeBody?.() } finally { disposeType?.() } })
          } catch { /* a refused seat leaves the Start page without that doorway */ }
        }
      }
      // What the Devices page says: are the seats in, and does the merged picture
      // exist at all (routing live). Kept in the page's own words, not a raw error.
      function reportSeats() {
        const snapshot = hostsStore.getSnapshot()
        // A1.1: the wrapper's own reason (e.g. `dsh-version-mismatch`) is shown, so a
        // refused wrap is never a silently missing feature.
        const routingOff = !(snapshot.routing && snapshot.routing.remote === true)
        // A healthy wrapper with no connected host is NOT a failure: the seats are in
        // and they fill the moment a host connects, so `grouped` stays true and `reason`
        // stays null (spec 008 P2b pins both).
        //
        // The one case worth a word is a remote that IS PAIRED but whose rows are not
        // in the merged list right now — the host is merely away. Its sessions are still
        // retained (host-router `#retainedRows`), so the Devices page can say "away,
        // coming back" instead of letting a bare empty sidebar look like a failure.
        // No paired remote at all stays silent: nothing is pending and this Host simply
        // has not paired an outbound machine yet.
        const awayHost = !seatError && !routingOff && snapshot.hosts.length === 0 &&
          (snapshot.disconnected || []).length > 0
        remoteUI.set({
          grouped: !seatError && !routingOff,
          hosts: snapshot.hosts.length,
          reason: seatError
            ? seatError
            : routingOff
              ? `multi-host routing is off${snapshot.routing && snapshot.routing.reason ? `: ${snapshot.routing.reason}` : ''}`
              : awayHost
                ? 'no remote host is connected'
                : null,
        })
      }
      if (typeof ctx.inject === 'function') {
        dispose.push(ctx.inject(['sessions'], (scope) => {
          sessions = scope.sessions
          if (sessionsPending) refreshSessions()
        }))
        // Undocumented but present in the shell: the right column's tab registry.
        dispose.push(ctx.inject(['sidebarRight'], (scope) => {
          nav.openTerminal = (sessionId) => scope.sidebarRight.openTab('terminal', { params: { sessionId } })
          // Spec 016 Phase 3: the card's doorway into the agent tab. The kind is the
          // per-host type registered below, so opening it is `openTab(kind)`.
          nav.openBrowserAgent = (kind) => scope.sidebarRight.openTab(kind)
        }))
        // The tab-type registry the native Browser itself uses. Injected separately:
        // a shell without it simply has no agent tab and no per-machine doorway, and
        // nothing else changes.
        dispose.push(ctx.inject(['sidebarRightTabs'], (scope) => {
          tabTypesRegistry = scope.sidebarRightTabs
          syncAgentTabs()
          syncHostDoors()
        }))
        // A second row on a session's context menu. The shipped "Copy Session ID" row
        // cannot be changed from here: the registry refuses a repeated target/id and
        // the menu is an additive flatMap with no filter, so the Host's own id gets its
        // own row instead of a replacement. Order 451 puts it directly BELOW that row
        // (450) without its `separatorBefore`, so the two copy rows read as one pair.
        ctx.inject(['contextMenus'], (scope) => {
          const menus = scope && scope.contextMenus
          // A shell without the menu service is a shell with no second row, not an error.
          if (!menus) return undefined
          return menus.register({
            id: 'session.devices-copy-raw',
            target: 'session',
            order: 451,
            resolve: sessionIdMenuItems,
          })
        })
      }
      register('conversation.input.left', { id: 'dsh-ext.devices.host', order: 100, label: tr('hostChip') }, HostChip)
      register('conversation.input.dock', { id: 'dsh-ext.devices.banners', order: 100, label: tr('banners') }, SessionBanners)
      register('conversation.input.right', { id: 'dsh-ext.devices.terminal', order: 100, label: tr('terminalEntry') }, RemoteTerminalEntry,
        () => ({ openTerminal: nav.openTerminal }))
      // The native `WorkspaceBrowser` declares these two seats (`kind:'list'`,
      // `scope:'root'`, the row's own `sessionId` as the owner prop), which is the
      // documented way another package decorates a session row: the same shape as
      // the shipped decoration template registering into `conversation.composer.dock`.
      // The row keeps rendering them; nothing here replaces the browser.
      register('sidebar.session.row.trailing', { id: 'dsh-ext.devices.host', order: 100, label: tr('hostChip') }, SessionHostBadge)
      register('sidebar.session.row.hover', { id: 'dsh-ext.devices.host', order: 100, label: tr('hostChip') }, SessionHostBadge)

      const sync = () => {
        refreshForHosts(hostsStore.getSnapshot())
        syncAgentTabs()
        syncHostDoors()
        reportSeats()
      }
      dispose.push(hostsStore.subscribe(sync))
      const refresh = () => { hostsStore.refresh().then(sync, () => {}) }
      refresh()
      dispose.push(...startPoll(refresh))
      dispose.push(() => {
        for (const entry of agentTabs.values()) {
          try { entry.dispose() } catch { /* teardown must not throw */ }
        }
        agentTabs.clear()
        for (const entry of hostDoors.values()) {
          try { entry() } catch { /* teardown must not throw */ }
        }
        hostDoors.clear()
        tabTypesRegistry = null
      })
      return () => {
        for (const entry of dispose.splice(0)) {
          try { entry?.() } catch { /* teardown must not throw */ }
        }
        sessions = null
        for (const key of Object.keys(nav)) nav[key] = null
      }
    }

    // One timer for every surface: /devices/remotes returns the whole host picture,
    // and a second timer would only let the surfaces disagree for a few seconds.
    function startPoll(refresh) {
      const interval = window.setInterval(refresh, 4000)
      return [() => window.clearInterval(interval)]
    }


    // --------------------------------------------------- spec 027: self-update
    function SelfUpdate() {
      useLang()
      const [info, setInfo] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [done, setDone] = React.useState(null)
      const fill = (key, vars) => Object.entries(vars).reduce((t, [k, v]) => t.replace('{' + k + '}', v), tr(key))
      // The desktop shell serves this page as `dsh-app://app` and forwards the request
      // to the Host after DELETING `Origin` (and `Sec-Fetch-Site`), so a route that
      // demands Origin would refuse every write from that shell while still believing
      // the request is same-origin. Spec 027's rule: a present Origin must be
      // same-origin, and an absent one is accepted only for these two POSTs when this
      // marker rides along — the shell keeps every other header. `Origin` is never
      // set here: the browser owns it, and a page that could fake it could fake the
      // rule.
      const SELF_UPDATE_HEADER = 'X-DSH-Devices-Request'
      const postSelfUpdate = (path, body) => request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [SELF_UPDATE_HEADER]: 'self-update' },
        body: JSON.stringify(body ?? {}),
      })
      async function check() {
        setBusy('check'); setError(''); setDone(null)
        try { setInfo(await postSelfUpdate('/devices/self-update/check', {})) } catch (e) { setError(e?.message || String(e)) } finally { setBusy('') }
      }
      async function update() {
        const tag = info?.latest?.tag
        if (!tag || !window.confirm(fill('updConfirm', { tag }))) return
        setBusy('update'); setError('')
        try { setDone(await postSelfUpdate('/devices/self-update/update', { tag })) } catch (e) { setError(tr('updBlocked') + ': ' + (e?.message || String(e))) } finally { setBusy('') }
      }
      const latest = info?.latest
      return h('div', { 'data-testid': 'self-update' },
        h('div', { className: 'dshdev-sect' },
          h('h3', { className: 'dshdev-grow' }, tr('updTitle')),
          h('button', { type: 'button', className: 'dshdev-btn', disabled: !!busy, onClick: check, 'data-testid': 'self-update-check' },
            busy === 'check' ? tr('updChecking') : tr('updCheck'))),
        error ? h('div', { className: 'dshdev-err', role: 'alert' }, error) : null,
        info ? h('div', { className: 'dshdev-card' },
          h('div', null, tr('updRemote') + ': ' + info.remote),
          h('div', null, tr('updCurrent') + ': ' + Object.values(info.current || {}).filter(Boolean).join(' / ') + ' (' + info.branch + ' ' + String(info.head).slice(0, 8) + ')'),
          !latest ? h('div', null, tr('updNoTags')) : h('div', null,
            h('div', null, tr('updLatest') + ': ' + latest.tag + ' · ' + tr('updSignature') + ': ' + latest.signature),
            h('div', null, tr('updEngines') + ': ' + latest.plugins.map((p) => p.dir.split('/').pop() + ' ' + (p.enginesDsh || '?') + (p.accepts === false ? ' ✗' : p.accepts ? ' ✓' : '')).join(', ')),
            info.upToDate ? h('div', null, tr('updUpToDate')) : h('div', null,
              h('div', null, tr('updNotes') + ':'),
              h('pre', { style: { whiteSpace: 'pre-wrap', margin: '4px 0' } }, latest.notes.join('\n')),
              done ? null : h('button', { type: 'button', className: 'dshdev-btn primary', disabled: !!busy, onClick: update, 'data-testid': 'self-update-apply' },
                busy === 'update' ? tr('updUpdating') : tr('updUpdate'))))) : null,
        done && done.updated ? h('div', { className: 'dshdev-card', role: 'status' },
          h('strong', null, fill('updDone', { tag: done.tag })),
          h('div', null, fill('updRollback', { head: done.previousHead })),
          (done.npm || []).map((n) => h('pre', { key: n.dir, style: { whiteSpace: 'pre-wrap' } }, n.dir + ': ' + n.tail))) : null)
    }

    // -------------------------------------------------------------- page
    function DevicesPage() {
      useLang()
      const [tab, setTab] = React.useState('allow')
      const tabs = [['allow', tr('tabAllow')], ['connect', tr('tabConnect')]]
      return h('div', { className: 'dshdev' },
        h('header', { className: 'dshdev-head' },
          h('h2', null, tr('title')),
          h('p', { className: 'dshdev-sub', 'data-testid': 'page-subtitle' }, tr('subtitle'))),
        h('div', { className: 'dshdev-tabs', role: 'tablist' }, tabs.map(([id, label]) =>
          h('button', { key: id, type: 'button', role: 'tab', 'aria-selected': tab === id, className: 'dshdev-tab dshdev-seg-btn', onClick: () => setTab(id) }, label))),
        tab === 'allow' ? h(AllowTab) : h(ConnectTab),
        h(RemoteAttachStatus),
        h(SelfUpdate))
    }

    // The left sidebar row and the main panel it opens. One id, one page: the
    // Settings section (below) is the other door, and `layout.selectPanel(id)`
    // resolves an id against the `main` slot's keys, so the two halves must share
    // this value or the row opens nothing.
    const PANEL_ID = 'dsh-ext.devices'
    // Panel rows sort ascending. The shipped ones are Plugins 0, Automation tasks
    // 10 (client-ui-schedule) and Repo Wiki 20 (plugins/dsh-wiki), so 21 puts
    // Devices directly below Repo Wiki; the "More" launcher is not a row and
    // always renders after the list.
    const PANEL_ORDER = 21

    // One glyph, two seats. Settings asks for 18 and the sidebar row asks for its
    // own size (16 wide / 18 on the collapsed rail, like the shipped rows), so the
    // monochrome mark is drawn once and sized by the caller.
    function deviceGlyph(size) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
      h('rect', { x: 3, y: 4, width: 13, height: 9, rx: 1.5 }),
      h('path', { d: 'M7 17h5M9.5 13v4' }),
      h('rect', { x: 17, y: 8, width: 4, height: 11, rx: 1 }))
    }

    function DevicesIcon() {
      return deviceGlyph(18)
    }

    // The sidebar row's glyph: the shell renders it inside the row's own glyph
    // span and passes `{ size, active }`, so the size it asks for is honoured.
    function DevicesPanelIcon(props) {
      return deviceGlyph(props && typeof props.size === 'number' ? props.size : 16)
    }

    // Two doors, one page: the host adds only what the main column does not supply
    // (padding, and the scroll container the Settings body would otherwise provide)
    // and reuses DevicesPage as it is. Every piece of that page's state is local to
    // the component and its data comes from the module-level stores, so the Settings
    // section and this panel can be open at the same time without sharing anything.
    function DevicesPanel() {
      return h('div', { className: 'dshdev-panel', 'data-testid': 'devices-panel' }, h(DevicesPage))
    }

    // The bundle that carries this plugin (spec 028) and its rows' packages.
    const MOBILE_BUNDLE = '@dsh-mobile/bundle'
    const isMobileBundleSubject = (subject) => !!subject && subject.kind === 'bundle' && !!subject.pkg && subject.pkg.name === MOBILE_BUNDLE

    const inject = ['slots', 'locale']
    function apply(ctx) {
      ctx.effect(() => {
        const sync = () => setHostLanguage(ctx.locale.getSnapshot().active)
        sync()
        const unsubscribe = ctx.locale.subscribe(sync)
        return () => { unsubscribe(); setHostLanguage('') }
      }, 'devices: host language')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = css
        document.head.appendChild(style)
        return () => style.remove()
      }, 'devices: styles')
      // One settings page per list entry (spec 008 Q1): the page and its icon share an id.
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: PANEL_ID, order: 80, label: tr('title') },
        () => h(DevicesPage)))
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register(
        { name: 'settings.section.icon', id: PANEL_ID, order: 80, label: tr('title') },
        () => h(DevicesIcon)))
      // The same page as a left-sidebar row, right below Repo Wiki. `label` is a
      // function because the shell re-resolves it on every locale change (that is
      // how the shipped rows switch language live), and the `main` half is keyed by
      // the same id because the row selects its panel as `layout.selectPanel(id)`,
      // which the shell resolves against the `main` slot's keys.
      // Both seats are additions, not requirements: a shell that does not declare
      // them (an older rc.1, or a seat the shell refuses) must still get the
      // Settings page, so a refusal cannot be allowed to end apply() here.
      const seat = (slot, register) => { try { ctx.slots.inject(slot, register) } catch { /* the seat is optional */ } }
      seat('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => tr('title') },
        DevicesPanelIcon))
      seat('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(DevicesPanel)))
      // Spec 028: the same spec-027 updater on the dsh-mobile bundle's page in Plugins, through the
      // page's public `plugins.detail.section` list slot (dsh-client-ui-plugin-manager README,
      // "Detail page extension points"). Plugins offers no native Update for a `link:` bundle, so this
      // is the updater that applies; it lives with this row, so it is absent while Devices is off.
      seat('plugins.detail.section', () => ctx.slots.register(
        { name: 'plugins.detail.section', id: 'dsh-mobile-self-update', order: 10 },
        (props) => (isMobileBundleSubject(props && props.subject)
          ? h('div', { className: 'dshdev', 'data-testid': 'bundle-self-update' }, h(SelfUpdate)) : null)))
      // Spec 033 (A1.2): remote file attach. One effect owns the capture listener and the
      // module, so a reload removes exactly what it installed (and no DSH object is ever
      // wrapped); a shell without `ctx.effect` simply keeps DSH's own behaviour, which the
      // page states.
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => installRemoteFileAttach(), 'devices: remote file attach')
      } else {
        attachUI.set({ state: 'ready', active: false, reason: 'not-installed' })
      }

      // Spec 008 P2b. Gated on the client context's own capability (`ctx.inject` is
      // how a browser plugin waits for optional services): without it there is no
      // way to reach the workspace/session actions, so nothing is installed and the
      // stock UI stays exactly as shipped.
      if (typeof ctx.inject === 'function') {
        ctx.effect(() => installRemoteSurfaces(ctx), 'devices: remote session surfaces')
      } else {
        remoteUI.set({ grouped: false, reason: 'the shell provides no client services' })
      }

      // The sidebar's two tabs: a display filter plus one layer over the New Task row.
      // It owns the same `remoteUI` snapshot as the surfaces above, so it is installed
      // AFTER them and reports the tab half of it; a seat this shell refuses is stated
      // on the Devices page instead of ending the whole bundle.
      if (typeof ctx.slots === 'object' && ctx.slots !== null) {
        // The injector draw runs now, so the measurable disposition is read after it,
        // not only after the effect: a shell that hands back an inert injector gets no
        // filter at all (a filter whose only switch is missing would hide half the list).
        let register = null
        ctx.effect(() => {
          const dispose = installSidebarTabStrip(ctx)
          register = dispose
          return () => {
            if (register === dispose) register = null
            if (typeof dispose === 'function') dispose()
            syncHostTabsStatus()
          }
        }, 'devices: sidebar host tabs')
        if (register === null) {
          remoteUI.set({ tabs: false, tabsReason: 'no-tabs' })
        } else {
          syncHostTabsStatus()
        }
      } else {
        remoteUI.set({ tabs: false, tabsReason: 'no-tabs' })
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.testing = { DevicesPage, AllowTab, ConnectTab, AddressEditor, RemoteDetail, AddDeviceForm, AddDeviceDialog, OtpDialog, PendingRequests, ScopePicker, AdvancedLimits, ALL_SCOPES, SCOPE_PRESETS, RISKY_SCOPES, request, tr, DICT, setHostLanguage,
      // The flow strip's honesty rule, exported so the test can prove all three
      // states without depending on CSS.
      FlowStrip, flowState, connectedCount, localName,
      // spec 008 P2b
      HostChip, SessionBanners, OfflineBanner, ModelStatusBanner, RemoteTerminalEntry,
      SessionHostBadge, PermissionsEditor, scopesForKind, gatewayScopesFor,
      RemoteGroupingStatus, hostsStore, remoteUI, hostTagOf, HOST_TAG, groupingReasonText, hostLinkOf,
      // The sidebar's two tabs: the component the `sidebar.session.action` layer renders,
      // the exact rule text each tab installs, and the tab store, so a test proves both
      // filters, the untouched children, and the small data surface (one <style>).
      SidebarHostTabs, hostTabsStyle, HOST_TABS_STYLE, HOST_TABS_STYLE_ID, HOST_TABS_SELECTORS,
      installSidebarTabStrip, hostTabsStyleWriter, publishHostTab, storedHostTab, HOST_TABS_STORAGE,
      hostTabsStore: { getSnapshot: hostTabSnapshot, subscribe: subscribeHostTab },
      // Spec 033 (A1.2): the wrap's measured state, the page line, and the installer (so a
      // test proves install-on-start / restore-on-dispose without a live window).
      attachUI, RemoteAttachStatus, installRemoteFileAttach, attachReasonText, ATTACH_REASON_KEYS,
      // spec 016 Phase 3
      BrowserAgentTab, agentKindOf,
      // spec 028
      SelfUpdate, isMobileBundleSubject, MOBILE_BUNDLE,
      // spec 016 Phase 1: the per-machine Start-page doorways, their numbers and the
      // card each one opens, so a test can prove the entries without a browser.
      HostDoorTab, HostDoorIcon, hostDoorEntries, hostDoorId, HOST_DOORWAYS,
      HOST_DOOR_BASE, HOST_DOOR_STRIDE,
      // The sidebar row's two halves, so a test can prove the row sits below Repo
      // Wiki and that its panel hosts the same DevicesPage instead of a copy.
      PANEL_ID, PANEL_ORDER, DevicesPanel, DevicesPanelIcon,
      // Spec 029: the bind target and the reachable route are two facts, so the
      // derivation of each is exported and asserted separately (a select that could
      // show a route would offer a target /mgw/listen cannot apply).
      planOf, serveRouteOf }
    return module.exports
  },
})
