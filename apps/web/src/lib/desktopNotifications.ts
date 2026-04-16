/**
 * Desktop Notifications utility — wraps the browser Notification API
 * with permission management and localStorage persistence.
 */

const STORAGE_KEY = 'desktop_notifications_enabled';
const DISMISSED_KEY = 'desktop_notif_dismissed';

export type NotificationPermissionState = 'default' | 'granted' | 'denied';

export function isDesktopNotifSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getDesktopNotifPermission(): NotificationPermissionState {
  if (!isDesktopNotifSupported()) return 'denied';
  return Notification.permission as NotificationPermissionState;
}

export function isDesktopNotifEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setDesktopNotifEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(enabled));
}

export function isBannerDismissed(): boolean {
  if (typeof window === 'undefined') return true;
  return localStorage.getItem(DISMISSED_KEY) === 'true';
}

export function dismissBanner(): void {
  localStorage.setItem(DISMISSED_KEY, 'true');
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!isDesktopNotifSupported()) return 'denied';
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    setDesktopNotifEnabled(true);
  }
  return result as NotificationPermissionState;
}

export function showDesktopNotification(options: {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
  onClick?: () => void;
}): void {
  if (!isDesktopNotifSupported()) return;
  if (Notification.permission !== 'granted') return;
  if (!isDesktopNotifEnabled()) return;
  if (document.hasFocus()) return; // Don't show when tab is focused

  const notif = new Notification(options.title, {
    body: options.body,
    icon: options.icon || '/landing/LOGO SEM FUNDO 01.png',
    tag: options.tag, // prevents duplicate notifications for same conversation
    silent: true,     // sound is handled by playNotificationSound
  });

  if (options.onClick) {
    notif.onclick = () => {
      window.focus();
      options.onClick!();
      notif.close();
    };
  }

  // Auto-close after 6 seconds
  setTimeout(() => notif.close(), 6000);
}
