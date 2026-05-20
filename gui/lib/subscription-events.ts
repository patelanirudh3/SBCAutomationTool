export const SUBSCRIBE_EVENT_OPTIONS = [
  { event: 'avaya-cm-feature-status', label: 'CM Feature Status', serverGroup: 'Avaya CM', refresh: true, unsubscribe: true },
  { event: 'avaya-cm-cc-info', label: 'CM CC Info', serverGroup: 'Avaya CM', refresh: true, unsubscribe: true },
  { event: 'dialog', label: 'Dialog', serverGroup: 'RFC', refresh: true, unsubscribe: true },
  { event: 'avaya-ccs-profile', label: 'CCS Profile', serverGroup: 'Avaya CCS', refresh: true, unsubscribe: true },
  { event: 'reg', label: 'Registration', serverGroup: 'RFC', refresh: true, unsubscribe: true },
  { event: 'message-summary', label: 'Message Summary', serverGroup: 'RFC', refresh: true, unsubscribe: true },
] as const

export const SUBSCRIBE_EVENT_VALUES = SUBSCRIBE_EVENT_OPTIONS.map((item) => item.event) as [
  'avaya-cm-feature-status',
  'avaya-cm-cc-info',
  'dialog',
  'avaya-ccs-profile',
  'reg',
  'message-summary',
]
