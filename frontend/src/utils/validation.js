// file: frontend/src/utils/validation.js
export function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

export function isValidUUID(str) {
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return re.test(str);
}

export function validateStringLength(str, min, max) {
  if (!str) return false;
  return str.length >= min && str.length <= max;
}
