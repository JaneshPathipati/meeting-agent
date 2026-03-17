// file: frontend/src/utils/formatDate.js
import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns';

export function formatDateTime(dateStr) {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  return format(date, 'MMM d, yyyy h:mm a');
}

export function formatDateShort(dateStr) {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  if (isToday(date)) return `Today ${format(date, 'h:mm a')}`;
  if (isYesterday(date)) return `Yesterday ${format(date, 'h:mm a')}`;
  return format(date, 'MMM d, h:mm a');
}

export function formatRelative(dateStr) {
  if (!dateStr) return '-';
  return formatDistanceToNow(new Date(dateStr), { addSuffix: true });
}

export function formatDateOnly(dateStr) {
  if (!dateStr) return '-';
  return format(new Date(dateStr), 'MMM d, yyyy');
}
