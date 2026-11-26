// Every UI string lives here (docs/specs/07-frontend.md 4.4), so an Arabic interface later is a translation,
// not a rewrite. Copy rules come from the design system: sentence case, verb-first buttons, no exclamation marks.

export const strings = {
  appName: 'Contact Export',
  tagline: 'Export group members from Telegram and WhatsApp.',
  loading: 'Loading…',
  platformNames: { telegram: 'Telegram', whatsapp: 'WhatsApp' },

  errors: {
    network: 'Could not reach the server. Check your connection and try again.',
    unexpected: 'Something went wrong. Please try again.',
  },

  topBar: { admin: 'Admin', logOut: 'Log out', loggingOut: 'Logging out…' },

  login: {
    title: 'Log in',
    email: 'Email',
    password: 'Password',
    submit: 'Log in',
    busy: 'Logging in…',
  },

  changePassword: {
    title: 'Choose a new password',
    intro: 'Your admin gave you a temporary password. Choose your own to continue.',
    introVoluntary: 'Change the password you use to log in.',
    current: 'Current password',
    next: 'New password',
    confirm: 'New password again',
    hint: 'At least 10 characters.',
    mismatch: "New passwords don't match.",
    submit: 'Change password',
    busy: 'Changing…',
    done: 'Password changed. Please log in again.',
    cancel: 'Cancel',
  },

  steps: ['Platform', 'Scan', 'Groups', 'Download'],

  connect: {
    chooseTitle: 'Choose a platform',
    chooseIntro: 'Pick the app whose groups you want to export. You will scan a QR code with your phone.',
    cardDescription: {
      telegram: 'Export members of your Telegram groups and supergroups.',
      whatsapp: 'Export members of the WhatsApp groups you are in.',
    },
    cardContinue: 'Continue',
    cardStarting: 'Starting…',
    whatsappNote:
      'WhatsApp may restrict accounts that use unofficial tools like this one. The app only reads your groups and never sends anything, but use it at your own risk.',

    scanTitle: 'Scan the QR code',
    scanWith: { telegram: 'Scan with Telegram', whatsapp: 'Scan with WhatsApp' },
    scanSteps: {
      telegram: ['Open Telegram on your phone.', 'Go to Settings → Devices → Link Desktop Device.', 'Point your phone at this code.'],
      whatsapp: ['Open WhatsApp on your phone.', 'Go to Settings → Linked devices → Link a device.', 'Point your phone at this code.'],
    },
    waiting: 'Waiting for scan… The code refreshes by itself.',
    linking: 'Linking…',
    cancel: 'Cancel',
    qrLabel: 'QR code to scan with your phone',

    passwordTitle: 'Enter your two-step verification password',
    passwordIntro: 'Your Telegram account has an extra password. It is sent to Telegram only and never stored.',
    passwordLabel: 'Two-step verification password',
    passwordHint: (hint: string) => `Hint: ${hint}`,
    passwordSubmit: 'Continue',
    passwordBusy: 'Checking…',

    loginFailed: "The login didn't finish. Please start again.",
    startAgain: 'Start again',
    connectionEnded: 'The connection ended (it may have timed out). Please start again.',

    groupsTitle: 'Pick groups',
    groupsIntro: 'Tick the groups whose members you want in the Excel file.',
    groupsLoading: 'Loading your groups…',
    retry: 'Try again',
    search: 'Search groups',
    searchPlaceholder: 'Search groups…',
    selected: (count: number, max: number) => `${count} selected (max ${max})`,
    selectAllShown: 'Select all shown',
    clear: 'Clear',
    noMatch: 'No groups match your search.',
    noGroups: "This account isn't in any groups yet.",
    hiddenTag: 'member list hidden',
    export: 'Export to Excel',
    exporting: 'Exporting… this can take a few minutes for big groups',
    disconnect: 'Disconnect',
    downloadFailed: 'The download failed. Please start again.',

    doneTitle: 'Done',
    done: 'Done. Your file is downloaded and your account was disconnected.',
  },

  admin: {
    title: 'Users',
    intro: 'Create accounts for your team and manage their access.',
    notAllowed: 'Only the admin can open this page.',
    backToConnect: 'Go to Connect',
    createLabel: 'Email of the new user',
    createPlaceholder: 'person@example.org',
    create: 'Create user',
    creating: 'Creating…',
    tempPasswordFor: 'Temporary password for',
    tempPasswordNote: 'This is shown only once. Send it to the user privately.',
    copy: 'Copy',
    copied: 'Copied',
    dismiss: 'Dismiss',
    columns: { email: 'Email', status: 'Status', password: 'Password', created: 'Created', lastLogin: 'Last login', actions: 'Actions' },
    active: 'Active',
    disabled: 'Disabled',
    temporary: 'Temporary',
    set: 'Set',
    never: 'Never',
    you: '(you)',
    resetPassword: 'Reset password',
    disable: 'Disable',
    enable: 'Enable',
    noUsers: 'No users yet.',
    confirmReset: (email: string) => `Reset the password for ${email}?`,
    confirmResetBody: "Their current password stops working, they are signed out, and you'll get a new temporary one to send them.",
    confirmDisable: (email: string) => `Disable ${email}?`,
    confirmDisableBody: 'They are signed out at once and their live connection ends. You can enable them again later.',
    cancel: 'Cancel',
    enabled: (email: string) => `${email} can log in again.`,
    disabledDone: (email: string) => `${email} was disabled.`,
  },
} as const;

/** Server messages are lowercase fragments ("wrong email or password"); show them as sentences. */
export function sentence(message: string) {
  const text = message.trim();
  if (!text) return text;
  const first = text.charAt(0).toLocaleUpperCase('en') + text.slice(1);
  return /[.!?…]$/.test(first) ? first : `${first}.`;
}
