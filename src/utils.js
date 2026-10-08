function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isStrongPassword(password) {
  const value = String(password || '');
  return value.length >= 8 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value) && /[^A-Za-z0-9]/.test(value);
}

function passwordPolicyMessage() {
  return 'Password must be at least 8 characters and include uppercase, lowercase, number, and symbol characters.';
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toISODateOrNull(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

function formatDateTime(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function formatMoney(value) {
  const number = Number(value || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(number);
}

function paginate(items, page, pageSize) {
  const currentPage = Math.max(Number(page) || 1, 1);
  const size = Math.max(Number(pageSize) || 10, 1);
  const start = (currentPage - 1) * size;
  return {
    items: items.slice(start, start + size),
    page: currentPage,
    pageSize: size,
    totalPages: Math.max(Math.ceil(items.length / size), 1),
    totalItems: items.length,
  };
}

function parseTags(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

module.exports = {
  escapeRegExp,
  normalizeEmail,
  isStrongPassword,
  passwordPolicyMessage,
  toNumberOrNull,
  toISODateOrNull,
  todayISO,
  formatDate,
  formatDateTime,
  formatMoney,
  paginate,
  parseTags,
};
