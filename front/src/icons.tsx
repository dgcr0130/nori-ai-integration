export type IconName = 'chat' | 'sidebar' | 'new' | 'close' | 'send'

export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 3v-11A8.5 8.5 0 0 1 9.5 3h3a8.5 8.5 0 0 1 8.5 8.5Z M7 10h8 M7 14h5',
    sidebar: 'M4 4h16v16H4Z M9 4v16 M6 8h1 M6 12h1',
    new: 'M12 4H4v16h16v-8 M10 14l1-4L19 2l3 3-8 8-4 1Z',
    close: 'M6 6l12 12 M18 6 6 18',
    send: 'M12 19V5 M5 12l7-7 7 7',
  }
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
